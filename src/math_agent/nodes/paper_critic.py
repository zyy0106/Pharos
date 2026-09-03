import os

from math_agent.config import (
    MIN_MODEL_CODE_SCORE,
    MIN_MODEL_CRITIC_SCORE,
    MODEL_ROUTING,
)
from math_agent.llm import complete
from math_agent.errors import LLMError
from math_agent.prompts.paper_critic import SYSTEM, build_prompt
from math_agent.state import CriticIssue, CriticReport, MathModelingState
from math_agent.nodes.table_assembler import _find_internal_terms
from math_agent.nodes.paper_evidence import offline_evidence_issues
from math_agent.tools.runner import extract_valid_result_lines, infer_entity_upper_bound


def _last_successful_stdout(state: MathModelingState) -> str:
    """汇总主求解器完整结构化证据及基线 RESULT，确保评审与 writer 同源。"""
    lines: list[str] = []
    upper_bound = infer_entity_upper_bound(state.data_files)
    for art in state.latest_code_artifacts():
        if not art.success or art.evidence_role not in {"primary", "baseline"}:
            continue
        if art.evidence_role == "primary":
            prefixes = (
                "SCENARIO_BEGIN:", "SCENARIO_Q1:", "RESULT:", "BREAKDOWN:",
                "DATA_PROFILE:", "DYNAMIC_STRESS:", "ALGORITHM_SEARCH:",
                "DEPARTURE_SEARCH:", "CROSS_ROUTE_SEARCH:", "ROBUSTNESS:",
                "SERVICE_DIAGNOSTICS:", "DYNAMIC_EVENTS:", "SCENARIO_END:",
            )
            lines.extend(
                line.strip()
                for line in art.stdout.splitlines()
                if line.strip().startswith(prefixes)
            )
            continue
        expected = art.category.split(":", 1)[1] if art.category.startswith("baseline:") else None
        lines.extend(extract_valid_result_lines(
            art.stdout,
            stderr=art.stderr,
            expected_identifier=expected,
            max_entity_count=upper_bound,
        ))
    return "\n".join(lines)


def _offline_paper_review(state: MathModelingState) -> CriticReport:
    """在显式离线模式下以可机检的论文证据替代不可用的远程评审。"""
    paper = state.paper
    sections = {
        "model_section": paper.model_section,
        "solution": paper.solution,
        "sensitivity": paper.sensitivity,
        "conclusion": paper.conclusion,
    }
    minimum_lengths = {
        "model_section": 3_000,
        "solution": 4_000,
        "sensitivity": 1_000,
        "conclusion": 1_500,
    }
    required = {
        "model_section": (
            r"\mathcal G_{k,h}", "分段旅行时间与能耗核算", "绿色区政策扩展",
        ),
        "solution": (
            "动态事件局部修复伪代码", "连续限行",
            "不等于备用车辆启用率为零", "碳排机制",
            "Q1无政策方案", "无邻域与发车优化",
            "题面文字",
        ),
        "sensitivity": (
            "3×3全因子", "描述性双因素平方和分解",
        ),
        "conclusion": (
            "连续事件", "Held–Karp", "主方案不能被宣称为成本最优",
        ),
    }
    issues: list[CriticIssue] = []
    for section, minimum in minimum_lengths.items():
        if len(sections[section]) < minimum:
            issues.append(CriticIssue(
                section=section,
                problem=f"离线评审：章节有效字符数不足（{len(sections[section])}<{minimum}）。",
            ))
    for section, phrases in required.items():
        missing = [phrase for phrase in phrases if phrase not in sections[section]]
        if missing:
            issues.append(CriticIssue(
                section=section,
                problem="离线评审缺少可核验论证：" + "、".join(missing),
            ))
    body = "\n".join(sections.values())
    forbidden = [
        term for term in (
            "8007", "10008", "12009", "图Sensitivity", "模拟退火", "变邻域搜索",
            "ALGORITHM_SEARCH", "DEPARTURE_SEARCH", "CROSS_ROUTE_SEARCH",
            "无调度方案是只关闭限行",
        )
        if term in body
    ]
    if forbidden:
        issues.append(CriticIssue(
            section="general",
            problem="离线评审发现内部编码、占位引用或未实现算法：" + "、".join(forbidden),
        ))
    for problem in offline_evidence_issues(state, body):
        issues.append(CriticIssue(
            section="general",
            problem="离线评审证据不一致：" + problem,
        ))
    approved = not issues
    return CriticReport(
        target="paper",
        score=9 if approved else max(4, 8 - len(issues)),
        approved=approved,
        issues=issues,
        suggestions=(
            []
            if approved
            else ["补足上述缺失证据后重新执行离线或远程论文评审。"]
        ),
        critic_type="offline_evidence_review",
    )


def paper_critic_node(state: MathModelingState) -> dict:
    p = state.paper
    if not any([p.abstract, p.model_section, p.solution]):
        report = CriticReport(
            target="paper", score=0, approved=False,
            issues=[CriticIssue(section="general", problem="论文初稿为空")],
            suggestions=["重新生成全部论文章节后再评审"],
        )
        return {
            "critic_reports": [report],
            "errors": ["paper_critic: 论文初稿为空，无法进入最终环节"],
        }

    try:
        out: CriticReport = complete(
            build_prompt(
                p,
                len(state.figures),
                len(state.sensitivity_runs),
                _last_successful_stdout(state),
                model_critic=state.latest_critic("modeler"),
                consistency=state.model_code_reports[-1] if state.model_code_reports else None,
                figures=state.figures,
                sensitivity_runs=state.sensitivity_runs,
            ),
            schema=CriticReport, system=SYSTEM,
            model=MODEL_ROUTING["paper_critic"],
        )
    except LLMError:
        if os.getenv("MATH_AGENT_OFFLINE_REVIEW", "").strip() != "1":
            raise
        out = _offline_paper_review(state)
    out.target = "paper"
    body = "\n".join(
        str(getattr(p, field, "") or "")
        for field in (
            "abstract", "problem_restatement", "assumptions", "notation",
            "model_section", "solution", "sensitivity", "conclusion",
        )
    )
    leaked = _find_internal_terms(body)
    if leaked:
        preview = "、".join(leaked[:8])
        out.issues.append(CriticIssue(
            section="general",
            problem=f"正文含工程内部流程标记：{preview}",
        ))
        out.suggestions.append("改用研究对象、模型、算法、实验和计算结果等竞赛论文语言。")
        out.score = min(out.score, 7)
        out.approved = False
    model_critic = state.latest_critic("modeler")
    if (
        model_critic is None
        or not model_critic.approved
        or model_critic.score < MIN_MODEL_CRITIC_SCORE
    ):
        score = model_critic.score if model_critic is not None else "缺失"
        out.issues.append(CriticIssue(
            section="model_section",
            problem=f"最终模型评审未达到正式论文标准（score={score}）。",
        ))
        out.suggestions.append("先修复最终模型覆盖、量纲、变量与验证计划，再重写论文。")
        out.score = min(out.score, 6)
        out.approved = False
    consistency = state.model_code_reports[-1] if state.model_code_reports else None
    if (
        consistency is None
        or not consistency.approved
        or consistency.score < MIN_MODEL_CODE_SCORE
    ):
        score = consistency.score if consistency is not None else "缺失"
        out.issues.append(CriticIssue(
            section="solution",
            problem=f"模型—代码一致性未达到正式论文标准（score={score}）。",
        ))
        out.suggestions.append("使求解代码完整实现最终模型的目标、约束和输出指标。")
        out.score = min(out.score, 6)
        out.approved = False
    control_names = {
        "\x08": "退格", "\t": "制表符", "\r": "回车控制符", "\x0c": "换页控制符",
    }
    controls = sorted({
        name for char, name in control_names.items() if char in body
    })
    if controls:
        out.issues.append(CriticIssue(
            section="general",
            problem="正文含疑似 LaTeX 转义损坏的控制字符：" + "、".join(controls),
        ))
        out.suggestions.append("修复反斜杠转义并重新渲染公式、符号表和 PDF。")
        out.score = min(out.score, 5)
        out.approved = False
    return {"critic_reports": [out]}
