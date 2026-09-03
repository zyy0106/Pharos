"""Evaluation Module：与 PaperCritic 解耦的独立量化打分。

为避免 LLM 在 overall 上算错，节点最终用确定性公式重算 overall。
"""
from __future__ import annotations

import os

from math_agent.config import (
    MIN_MODEL_CODE_SCORE,
    MIN_MODEL_CRITIC_SCORE,
    MODEL_ROUTING,
)
from math_agent.llm import complete
from math_agent.errors import LLMError
from math_agent.nodes.table_assembler import _find_internal_terms
from math_agent.nodes.paper_evidence import offline_evidence_issues, paper_body
from math_agent.prompts.evaluation import SYSTEM, build_prompt
from math_agent.state import EvaluationReport, MathModelingState


_WEIGHTS = {
    "assumption_reasonableness": 0.20,
    "modeling_creativity": 0.25,
    "result_correctness": 0.25,
    "writing_clarity": 0.20,
    "extra_depth": 0.10,
}


def _compute_overall(r: EvaluationReport) -> float:
    total = sum(getattr(r, k) * w for k, w in _WEIGHTS.items())
    return round(total, 2)


def _unwrap_scores(raw: EvaluationReport) -> EvaluationReport:
    """如果 LLM 返回嵌套 scores 而非顶层字段，解包并重新赋值。"""
    scores_raw = getattr(raw, "_scores", None) or getattr(raw, "scores", None)
    if scores_raw is None:
        return raw
    # 尝试从嵌套 scores dict 里提取各维度分
    for dim in _WEIGHTS:
        if getattr(raw, dim, None) is None:
            val = scores_raw.get(dim)
            if val is not None:
                setattr(raw, dim, val)
    return raw


def _offline_evaluation(state: MathModelingState) -> EvaluationReport:
    """以结构化证据和正文契约计算离线质量分，不复用旧轮次总分。"""
    paper = state.paper
    body = paper_body(state)
    model_critic = state.latest_critic("modeler")
    consistency = state.model_code_reports[-1] if state.model_code_reports else None
    upstream_ok = bool(
        model_critic and model_critic.approved and model_critic.score >= MIN_MODEL_CRITIC_SCORE
        and consistency and consistency.approved and consistency.score >= MIN_MODEL_CODE_SCORE
    )
    assumptions_ok = len(paper.assumptions) >= 700 and upstream_ok
    model_depth = all(
        phrase in body
        for phrase in (
            r"\mathcal G_{k,h}", "连续限行", "3×3全因子", "描述性双因素平方和分解",
        )
    )
    evidence_issues = offline_evidence_issues(state, body)
    result_depth = not evidence_issues and all(
        phrase in body
        for phrase in (
            "Held–Karp",
            "不等于备用车辆启用率为零", "Q1无政策方案",
            "无邻域与发车优化", "题面文字",
        )
    )
    clear_sections = all(
        len(str(getattr(paper, section, "") or "")) >= minimum
        for section, minimum in (
            ("model_section", 3_000),
            ("solution", 4_000),
            ("sensitivity", 1_000),
            ("conclusion", 1_500),
        )
    )
    forbidden = any(
        term in body
        for term in (
            "8007", "10008", "12009", "图Sensitivity", "模拟退火", "变邻域搜索",
            "ALGORITHM_SEARCH", "DEPARTURE_SEARCH", "CROSS_ROUTE_SEARCH",
            "无调度方案是只关闭限行",
        )
    ) or bool(_find_internal_terms(body))
    extra_depth = all(
        phrase in body
        for phrase in (
            "Held–Karp", "蒙特卡洛",
            "连续事件", "碳排机制",
        )
    ) and not evidence_issues
    report = EvaluationReport(
        assumption_reasonableness=9 if assumptions_ok else 6,
        modeling_creativity=9 if model_depth else 7,
        result_correctness=9 if upstream_ok and result_depth else 6,
        writing_clarity=9 if clear_sections and not forbidden else 6,
        extra_depth=9 if extra_depth else 7,
        issues=[],
        suggestions=[],
    )
    if not upstream_ok:
        report.issues.append("离线评估：最终模型评审或模型—代码一致性未通过。")
    if forbidden:
        report.issues.append("离线评估：正文仍含内部编码、占位引用、未实现算法或流程标记。")
    if not result_depth:
        report.issues.append("离线评估：关键基线、精确对照或动态指标边界证据不完整。")
    report.issues.extend(
        f"离线评估证据不一致：{issue}" for issue in evidence_issues
    )
    if not extra_depth:
        report.suggestions.append("补充二维效应分解、随机稳健性、精确对照和连续事件边界。")
    report.overall = _compute_overall(report)
    return report


def evaluation_node(state: MathModelingState) -> dict:
    p = state.paper
    if not any([p.abstract, p.model_section, p.solution]):
        return {"errors": ["evaluation: 论文初稿为空，跳过评估"]}

    paper_critic = state.latest_critic("paper")
    depth_labels = (
        "ALGORITHM_SEARCH", "ROBUSTNESS", "SERVICE_DIAGNOSTICS", "DYNAMIC_EVENTS",
    )
    depth_signals = {
        label: any(
            artifact.success and artifact.evidence_role == "primary"
            and f"{label}:" in (artifact.stdout or "")
            for artifact in state.latest_code_artifacts()
        )
        for label in depth_labels
    }
    try:
        out: EvaluationReport = complete(
            build_prompt(
                p, state.figures, state.sensitivity_runs, paper_critic,
                state.table_warnings,
                depth_signals=depth_signals,
                model_critic=state.latest_critic("modeler"),
                consistency=state.model_code_reports[-1] if state.model_code_reports else None,
            ),
            schema=EvaluationReport, system=SYSTEM,
            model=MODEL_ROUTING["evaluation"],
        )
    except LLMError:
        if os.getenv("MATH_AGENT_OFFLINE_REVIEW", "").strip() != "1":
            raise
        out = _offline_evaluation(state)
    out = _unwrap_scores(out)
    model_critic = state.latest_critic("modeler")
    if (
        model_critic is None
        or not model_critic.approved
        or model_critic.score < MIN_MODEL_CRITIC_SCORE
    ):
        out.modeling_creativity = min(out.modeling_creativity, 6)
        out.result_correctness = min(out.result_correctness, 5)
        out.issues.append("最终模型评审未通过，论文表达不能抵消模型层缺陷。")
    consistency = state.model_code_reports[-1] if state.model_code_reports else None
    if (
        consistency is None
        or not consistency.approved
        or consistency.score < MIN_MODEL_CODE_SCORE
    ):
        out.result_correctness = min(out.result_correctness, 5)
        out.issues.append("模型—代码一致性未通过，结果正确性不得评为优秀。")
    out.overall = _compute_overall(out)  # 确定性自校正
    return {"evaluation": out}
