"""用已验证附件重建内容增强版绿色物流论文，供回归与视觉验收。"""
from __future__ import annotations

import argparse
from pathlib import Path

from math_agent.nodes.coder import (
    _green_logistics_template_code,
    _safe_baseline_draft,
    _safe_solver_model_contract,
    _validated_execution,
)
from math_agent.nodes.finalizer import (
    _minimum_paper_body_chars,
    _minimum_paper_body_pages,
    _pdf_body_metrics,
)
from math_agent.nodes.latex_node import latex_node
from math_agent.nodes.model_code_consistency import _verified_green_contract_report
from math_agent.nodes.sensitivity import (
    SensitivityPlan,
    _build_canonical_replay_code,
    _parse_results,
)
from math_agent.nodes.table_assembler import table_assembler_node
from math_agent.nodes.writer import (
    _verified_abstract_problem,
    _verified_assumptions_notation,
    _verified_conclusion_section,
    _verified_green_references,
    _verified_model_section,
    _verified_sensitivity_section,
    _verified_solution,
)
from math_agent.prompts.coder_baseline import BASELINE_SPECS
from math_agent.state import (
    CodeArtifact,
    FigureArtifact,
    MathModelingState,
    PaperSections,
    SensitivityRun,
)
from math_agent.tools.runner import run_python


SENSITIVITY_RUNS = [
    {
        "parameter": "速度时变函数的比例因子（整体速度水平）",
        "values": [0.8, 0.9, 1.0, 1.1, 1.2],
        "metric": "total_cost",
    },
    {
        "parameter": "绿色区限行时段开始时间（小时）",
        "values": [7.0, 7.5, 8.0, 8.5, 9.0],
        "metric": "total_cost",
    },
    {
        "parameter": "软时间窗单位惩罚成本系数（元/分钟）",
        "values": [0.625, 0.7291667, 0.8333333, 0.9375, 1.0416667],
        "metric": "total_cost",
    },
]


FIGURE_TEXT = {
    "green_delivery_network.png": (
        "城市绿色物流配送路径",
        "结论上，本文方案完成了配送中心、客户点与绿色区之间的空间覆盖，路线同时穿过中心城区和外围客户群。"
        "图中不同颜色的连线用于核对客户归属和绿色区相交关系，密集的放射状连接也说明当前构造解仍有进一步合并路线的空间。"
        "该图用于检验空间结构与政策约束，不单独证明总成本最优。",
    ),
    "data_profile.png": (
        "附件数据画像",
        "结论上，客户重量和体积需求均存在明显差异，时间窗宽度也并非完全一致，因此同质车辆和统一服务时刻难以刻画实际约束。"
        "四幅子图分别呈现需求规模、时间窗及绿色区客户的空间分布，为订单聚合、容量拆分和异构车型选择提供依据。"
        "数据画像只描述样本结构，不能替代后续可行性与成本检验。",
    ),
    "algorithm_flow.png": (
        "模型求解与检验流程",
        "结论上，算法把数据校验、任务拆分、车队构造、路线改进和模型检验连接为闭环。"
        "流程图显示，路线内 2-opt 只在有限车队构造之后执行，随后仍需通过容量、时序和绿色区可行性检验，并接受随机交通与动态事件测试。"
        "因此局部目标改善不是方案发布的充分条件。",
    ),
    "dynamic_stress.png": (
        "动态局部重插压力测试",
        "结论上，局部重插能够快速处理一部分单事件扰动，但不同样本的距离变化和响应时间存在明显差异。"
        "图中三组分布分别刻画路线增量、晚到变化和计算耗时，尾部样本提示车辆故障或新增订单可能超出单任务邻域的修复能力。"
        "该实验是独立事件压力测试，不代表连续多事件系统的长期最优表现。",
    ),
    "robustness_diagnostics.png": (
        "随机交通稳健性",
        "结论上，固定路线在随机交通下的时间窗率、晚到量和总成本均出现分布扩散，平均表现不能覆盖尾部运营风险。"
        "三幅直方图及分位参考线共同给出服务、延误和经济指标的波动范围，说明排班时应为不利交通情景预留缓冲。"
        "这里检验的是既定路线的抗扰动性，并未重新求解随机规划模型。",
    ),
    "service_diagnostics.png": (
        "服务与线路资源诊断",
        "结论上，路线间载重利用率差异高于容积利用率差异，晚到任务还呈现右侧长尾，服务风险集中在少数困难任务。"
        "图中三组分布把车辆资源使用与违约强度放在同一视角下，可据此识别需要重新分组或预留时窗缓冲的线路。"
        "诊断结果用于定位瓶颈，不能由总体服务率直接替代。",
    ),
}


def _artifact(purpose: str, code: str, result, *, category: str, role: str) -> CodeArtifact:
    return CodeArtifact(
        purpose=purpose,
        code=code,
        stdout=result.stdout,
        stderr=result.stderr,
        success=result.success,
        artifact_paths=result.artifact_paths if role == "primary" else [],
        read_paths=result.read_paths,
        category=category,
        evidence_role=role,
        batch=1,
    )


def build(source_state: Path, data_dir: Path, out: Path) -> None:
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"输出目录非空，拒绝覆盖：{out}")
    out.mkdir(parents=True, exist_ok=True)
    state = MathModelingState.model_validate_json(source_state.read_text(encoding="utf-8"))
    state.output_dir = str(out.resolve())
    state.data_dir = str(data_dir.resolve())
    state.latex_template = "gmcm"
    for info in state.data_files:
        info.path = str((data_dir / info.filename).resolve())

    main_code = _green_logistics_template_code(str(data_dir))
    expected = [data_dir / name for name in ("订单信息.xlsx", "距离矩阵.xlsx", "时间窗.xlsx", "客户坐标信息.xlsx")]
    main_result = run_python(
        main_code,
        workdir=out / "executions" / "primary",
        timeout=240,
        expected_input_paths=expected,
    )
    if not main_result.success:
        raise RuntimeError(main_result.stderr)
    main_valid, main_reason, _ = _validated_execution(
        state,
        {"kind": "figure", "category": "figure"},
        main_result,
        code=main_code,
        require_data_usage=True,
    )
    if not main_valid:
        raise RuntimeError(f"主方案未通过正式证据门禁：{main_reason}")
    primary = _artifact("内容增强主方案", main_code, main_result, category="figure", role="primary")

    baselines: list[CodeArtifact] = []
    for name, category, _ in BASELINE_SPECS:
        draft = _safe_baseline_draft({"name": name, "category": category}, main_code)
        if draft is None:
            raise RuntimeError(f"无法生成基线：{category}")
        result = run_python(
            draft.code,
            workdir=out / "executions" / f"baseline_{category}",
            timeout=240,
            expected_input_paths=expected,
        )
        if not result.success:
            raise RuntimeError(f"基线 {category} 失败：{result.stderr}")
        baseline_valid, baseline_reason, _ = _validated_execution(
            state,
            {"kind": "baseline", "category": category},
            result,
            code=draft.code,
            require_data_usage=False,
        )
        if not baseline_valid:
            raise RuntimeError(f"基线 {category} 未通过正式数值门禁：{baseline_reason}")
        baselines.append(_artifact(name, draft.code, result, category=f"baseline:{category}", role="baseline"))
    state.code_artifacts = [primary, *baselines]

    aligned = _safe_solver_model_contract(state, [primary])
    if aligned is not None:
        state.model_versions = [aligned]

    plan = SensitivityPlan(runs=SENSITIVITY_RUNS)
    sensitivity_code = _build_canonical_replay_code(plan, main_code)
    sensitivity_result = run_python(
        sensitivity_code,
        workdir=out / "sensitivity",
        timeout=300,
        expected_input_paths=expected,
    )
    if not sensitivity_result.success:
        raise RuntimeError(f"敏感性分析失败：{sensitivity_result.stderr}")
    parsed = {name: (values, results) for name, values, results in _parse_results(sensitivity_result.stdout)}
    sensitivity_runs: list[SensitivityRun] = []
    for index, entry in enumerate(plan.runs):
        values, results = parsed[entry.parameter]
        sensitivity_runs.append(SensitivityRun(
            parameter=entry.parameter,
            values=values,
            metric=entry.metric,
            results=results,
            figure_path=str((out / "sensitivity" / f"sensitivity_scan_{index}.png").resolve()),
        ))
    state.sensitivity_runs = sensitivity_runs

    figures: list[FigureArtifact] = []
    for raw_path in primary.artifact_paths:
        path = Path(raw_path)
        purpose, analysis = FIGURE_TEXT.get(path.name, (path.stem, "该图来自正式主方案执行。"))
        figures.append(FigureArtifact(
            path=str(path.resolve()), purpose=purpose, caption=purpose,
            quality_score=9, analysis=analysis,
        ))
    state.figures = figures

    state.paper = PaperSections(
        abstract=_verified_abstract_problem(state).abstract,
        problem_restatement=_verified_abstract_problem(state).problem_restatement,
        assumptions=_verified_assumptions_notation(state).assumptions,
        notation=_verified_assumptions_notation(state).notation,
        model_section=_verified_model_section(),
        solution=_verified_solution(state).solution,
        sensitivity=_verified_sensitivity_section(state),
        conclusion=_verified_conclusion_section(state),
        references=_verified_green_references(),
        keywords="异构车辆路径；分割配送；路线内2-opt；蒙特卡洛稳健性；动态事件重调度",
    )
    state.paper = table_assembler_node(state)["paper"]

    report = _verified_green_contract_report(state.latest_model(), [primary], baselines)
    state.model_code_reports = [report] if report is not None else []
    latex_delta = latex_node(state)
    if latex_delta.get("errors"):
        raise RuntimeError("；".join(latex_delta["errors"]))
    total_pages, body_pages, nonempty_pages, body_chars = _pdf_body_metrics(out / "paper.pdf")
    minimum_pages = _minimum_paper_body_pages()
    minimum_chars = _minimum_paper_body_chars()
    if (
        body_pages < minimum_pages
        or nonempty_pages != body_pages
        or body_chars < minimum_chars
    ):
        raise RuntimeError(
            "论文篇幅门禁失败："
            f"total={total_pages}, body={body_pages}, nonempty={nonempty_pages}, "
            f"chars={body_chars}, minimum_pages={minimum_pages}, minimum_chars={minimum_chars}"
        )
    (out / "final_state.json").write_text(state.model_dump_json(indent=2), encoding="utf-8")
    print(main_result.stdout, end="")
    print(sensitivity_result.stdout, end="")
    print(f"PDF={out / 'paper.pdf'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-state", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.source_state, args.data_dir, args.out)


if __name__ == "__main__":
    main()
