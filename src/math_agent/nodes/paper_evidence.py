"""论文离线评审使用的结构化证据提取与动态一致性检查。"""

from __future__ import annotations

import math
import re

from math_agent.nodes.sensitivity import (
    formal_sensitivity_issues,
    formal_sensitivity_runs,
)
from math_agent.state import MathModelingState, SensitivityRun
from math_agent.tools.runner import infer_entity_upper_bound, validate_numeric_results


PAPER_FIELDS = (
    "abstract",
    "problem_restatement",
    "assumptions",
    "notation",
    "model_section",
    "solution",
    "sensitivity",
    "conclusion",
)


def paper_body(state: MathModelingState) -> str:
    return "\n".join(
        str(getattr(state.paper, field, "") or "")
        for field in PAPER_FIELDS
    )


def verified_result_map(
    state: MathModelingState,
) -> dict[str, dict[str, float]]:
    """只提取最新批次、已成功且通过统一数值门禁的正式 RESULT。"""
    results: dict[str, dict[str, float]] = {}
    upper_bound = infer_entity_upper_bound(state.data_files)
    for artifact in state.latest_code_artifacts():
        if (
            not artifact.success
            or artifact.evidence_role not in {"primary", "baseline"}
        ):
            continue
        expected = (
            artifact.category.split(":", 1)[1]
            if artifact.category.startswith("baseline:")
            else None
        )
        valid, _, parsed = validate_numeric_results(
            artifact.stdout,
            stderr=artifact.stderr,
            require_result=True,
            expected_identifier=expected,
            max_entity_count=upper_bound,
        )
        if not valid:
            continue
        if artifact.evidence_role == "primary":
            if set(parsed) != {"ours"}:
                continue
            q1_match = re.search(
                r"(?m)^SCENARIO_Q1:\s*baseline=no_policy\s+(.+)$",
                artifact.stdout,
            )
            if q1_match:
                q1_metrics = {
                    item.group(1): float(item.group(2))
                    for item in re.finditer(
                        r"([A-Za-z_][\w]*)=(-?(?:\d+(?:\.\d+)?|\.\d+))",
                        q1_match.group(1),
                    )
                }
                if q1_metrics and all(
                    math.isfinite(value) for value in q1_metrics.values()
                ):
                    results["q1_no_policy"] = q1_metrics
            results["ours"] = parsed["ours"]
            continue
        if expected is None or set(parsed) != {expected}:
            continue
        results[expected] = parsed[expected]
    return results


def verified_structured_map(
    state: MathModelingState,
    label: str,
    scenario: str = "q2_green_policy",
) -> dict[str, float]:
    """从最新绿色物流主证据的指定场景结构化行提取数值字段。"""
    primary = next(
        (
            artifact
            for artifact in reversed(state.latest_code_artifacts())
            if artifact.success
            and artifact.evidence_role == "primary"
            and "BEACON_GREEN_LOGISTICS_SAFE_SOLVER" in artifact.code
        ),
        None,
    )
    if primary is None:
        return {}
    scenario_match = re.search(
        rf"(?ms)^SCENARIO_BEGIN:\s*{re.escape(scenario)}\s*$"
        rf"(.*?)^SCENARIO_END:\s*{re.escape(scenario)}\s*$",
        primary.stdout,
    )
    source = scenario_match.group(1) if scenario_match else primary.stdout
    match = re.search(rf"(?m)^{re.escape(label)}:\s+(.+)$", source)
    if match is None:
        return {}
    values = {
        item.group(1): float(item.group(2))
        for item in re.finditer(
            r"([A-Za-z_][\w]*)=(-?(?:\d+(?:\.\d+)?|\.\d+))",
            match.group(1),
        )
    }
    return values if all(math.isfinite(value) for value in values.values()) else {}


def factorial_effect_percentages(
    run: SensitivityRun,
) -> tuple[float, float, float] | None:
    """返回 3×3 网格的速度、政策时点和交互描述性贡献率。"""
    if len(run.values) != 9 or len(run.results) != 9:
        return None
    matrix = [
        [float(value) for value in run.results[row * 3:(row + 1) * 3]]
        for row in range(3)
    ]
    if not all(math.isfinite(value) for row in matrix for value in row):
        return None
    grand = sum(sum(row) for row in matrix) / 9.0
    row_means = [sum(row) / 3.0 for row in matrix]
    column_means = [
        sum(matrix[row][column] for row in range(3)) / 3.0
        for column in range(3)
    ]
    total = sum((value - grand) ** 2 for row in matrix for value in row)
    if total <= 1e-12:
        return None
    speed = 3.0 * sum((value - grand) ** 2 for value in row_means)
    start = 3.0 * sum((value - grand) ** 2 for value in column_means)
    interaction = max(0.0, total - speed - start)
    return tuple(100.0 * value / total for value in (speed, start, interaction))


def _contains_number(body: str, value: float, *, suffix: str = "") -> bool:
    compact = body.replace(",", "")
    magnitude = abs(value)
    if 0 < magnitude < 0.01:
        decimals = (6, 8, 10)
    elif magnitude < 1:
        decimals = (2, 4, 6, 8)
    else:
        decimals = (0, 2, 4, 6, 8)
    for places in decimals:
        fixed = f"{value:.{places}f}"
        tokens = {fixed}
        if places:
            tokens.add(fixed.rstrip("0").rstrip("."))
        for token in tokens:
            pattern = rf"(?<![\d.]){re.escape(token)}{re.escape(suffix)}(?![\d.])"
            if re.search(pattern, compact):
                return True
    return False


def _contains_number_near(
    body: str,
    value: float,
    labels: tuple[str, ...],
    *,
    suffix: str = "",
    window: int = 120,
) -> bool:
    compact = body.replace(",", "")
    magnitude = abs(value)
    decimals = (
        (6, 8, 10)
        if 0 < magnitude < 0.01
        else (2, 4, 6, 8) if magnitude < 1 else (0, 2, 4, 6, 8)
    )
    tokens: set[str] = set()
    for places in decimals:
        fixed = f"{value:.{places}f}"
        tokens.add(fixed)
        if places:
            tokens.add(fixed.rstrip("0").rstrip("."))
    for token in tokens:
        pattern = rf"(?<![\d.]){re.escape(token)}{re.escape(suffix)}(?![\d.])"
        for match in re.finditer(pattern, compact):
            context = compact[
                max(0, match.start() - window):match.end() + window
            ]
            if any(label in context for label in labels):
                return True
    return False


def _contains_number_after_label(
    body: str,
    value: float,
    labels: tuple[str, ...],
    *,
    suffix: str = "",
    max_gap: int = 48,
    blockers: tuple[str, ...] = (),
) -> bool:
    """要求数值紧跟语义标签，避免同段内其他指标的数值串位。"""
    compact = body.replace(",", "")
    magnitude = abs(value)
    decimals = (
        (6, 8, 10)
        if 0 < magnitude < 0.01
        else (2, 4, 6, 8) if magnitude < 1 else (0, 2, 4, 6, 8)
    )
    tokens: set[str] = set()
    for places in decimals:
        fixed = f"{value:.{places}f}"
        tokens.add(fixed)
        if places:
            tokens.add(fixed.rstrip("0").rstrip("."))
    for label in labels:
        for label_match in re.finditer(re.escape(label), compact):
            tail = compact[label_match.end():label_match.end() + max_gap]
            for token in tokens:
                pattern = rf"(?<![\d.]){re.escape(token)}{re.escape(suffix)}(?![\d.])"
                number_match = re.search(pattern, tail)
                if (
                    number_match is not None
                    and not any(
                        blocker in tail[:number_match.start()]
                        for blocker in blockers
                    )
                ):
                    return True
    return False


def _contains_number_before_label(
    body: str,
    value: float,
    labels: tuple[str, ...],
    *,
    suffix: str = "",
    max_gap: int = 24,
) -> bool:
    """要求数值紧邻并位于语义标签之前。"""
    compact = body.replace(",", "")
    magnitude = abs(value)
    decimals = (
        (6, 8, 10)
        if 0 < magnitude < 0.01
        else (2, 4, 6, 8) if magnitude < 1 else (0, 2, 4, 6, 8)
    )
    tokens: set[str] = set()
    for places in decimals:
        fixed = f"{value:.{places}f}"
        tokens.add(fixed)
        if places:
            tokens.add(fixed.rstrip("0").rstrip("."))
    for label in labels:
        for label_match in re.finditer(re.escape(label), compact):
            head = compact[max(0, label_match.start() - max_gap):label_match.start()]
            for token in tokens:
                pattern = rf"(?<![\d.]){re.escape(token)}{re.escape(suffix)}[^\d]{{0,{max_gap}}}$"
                if re.search(pattern, head):
                    return True
    return False


def offline_evidence_issues(
    state: MathModelingState,
    body: str | None = None,
) -> list[str]:
    """确认离线高分所引用的数值来自本次正式结构化产物。"""
    body = body if body is not None else paper_body(state)
    results = verified_result_map(state)
    issues: list[str] = []
    for required in ("ours", "q1_no_policy"):
        if required not in results:
            issues.append(f"缺少本次正式结构化结果：{required}")
    result_labels = {
        "ours": ("本文方案", "主方案", "Q2"),
        "q1_no_policy": ("Q1", "无政策方案"),
        "no_schedule": ("无邻域与发车优化", "no_schedule"),
        "simple_pred": ("定速预测", "simple_pred"),
        "greedy": ("贪婪构造", "greedy"),
    }
    all_result_labels = tuple({
        label
        for labels in result_labels.values()
        for label in labels
    })
    for identifier, metrics in results.items():
        total_cost = metrics.get("total_cost", metrics.get("cost"))
        labels = result_labels.get(identifier, (identifier,))
        if total_cost is not None and not _contains_number_after_label(
            body,
            total_cost,
            labels,
            max_gap=48,
            blockers=tuple(
                label for label in all_result_labels if label not in labels
            ),
        ):
            issues.append(
                f"正文未引用本次 {identifier} 的 total_cost={total_cost:.12g}"
            )

    ours = results.get("ours", {})
    dynamic_ratio = ours.get("dynamic_cost_increase_ratio")
    if dynamic_ratio is not None and not _contains_number_after_label(
        body,
        dynamic_ratio,
        ("代理成本相对静态总成本之比", "动态成本比例"),
        max_gap=40,
    ):
        issues.append(
            "正文动态成本比例与本次主方案 RESULT 不一致"
        )

    issues.extend(formal_sensitivity_issues(state))
    interaction = next(
        (
            run
            for run in formal_sensitivity_runs(state)
            if "二维组合编码" in run.parameter
        ),
        None,
    )
    effects = (
        factorial_effect_percentages(interaction)
        if interaction is not None
        else None
    )
    if effects is None:
        issues.append("缺少本次完整 3×3 二维敏感性结构化证据")
    else:
        labels = (
            (("速度主效应",), ("限行开始时刻主效应", "限行时点主效应", "交互残差")),
            (("限行开始时刻主效应", "限行时点主效应"), ("速度主效应", "交互残差")),
            (("不可加交互残差", "交互残差"), ("速度主效应", "限行时点主效应")),
        )
        for (effect_labels, blockers), value in zip(labels, effects):
            if not _contains_number_after_label(
                body,
                value,
                effect_labels,
                suffix="%",
                max_gap=80,
                blockers=blockers,
            ):
                label = effect_labels[0]
                issues.append(f"正文未引用本次{label}贡献率 {value:.2f}%")

    stress = verified_structured_map(state, "DYNAMIC_STRESS")
    required_stress = ("samples", "success", "success_rate")
    if not all(key in stress for key in required_stress):
        issues.append("缺少本次 DYNAMIC_STRESS 样本数、成功数或成功率证据")
    else:
        samples = stress["samples"]
        success = stress["success"]
        success_rate = stress["success_rate"]
        if samples <= 0 or abs(success / samples - success_rate) > 1e-9:
            issues.append("DYNAMIC_STRESS 样本数、成功数与成功率不自洽")
        samples_ok = _contains_number_after_label(
            body, samples, ("独立事件样本", "压力测试样本数"), max_gap=24,
        ) or _contains_number_before_label(
            body, samples, ("个移动任务压力样本",), max_gap=12,
        )
        if not samples_ok:
            issues.append("正文未引用本次动态压力测试样本数")
        if not _contains_number_after_label(
            body, success, ("成功重插样本", "成功"), max_gap=20,
            blockers=("成功率",),
        ):
            issues.append("正文未引用本次动态压力测试成功数")
        success_rate_ok = _contains_number_after_label(
            body,
            100.0 * success_rate,
            ("成功率",),
            suffix="%",
            max_gap=16,
        ) or _contains_number_before_label(
            body,
            100.0 * success_rate,
            ("成功率",),
            suffix="%",
            max_gap=6,
        )
        if not success_rate_ok:
            issues.append("正文动态压力测试成功率与本次结构化证据不一致")

    profile = verified_structured_map(state, "DATA_PROFILE")
    green_customers = profile.get("green_customers")
    coordinate_green = profile.get("coordinate_green_customers")
    if green_customers is None:
        issues.append("缺少本次 DATA_PROFILE 绿色区有效需求客户证据")
    elif not _contains_number_near(
        body,
        green_customers,
        ("绿色区", "正需求", "附件口径"),
        window=100,
    ):
        issues.append("正文未引用本次绿色区有效需求客户数")
    if coordinate_green is None:
        issues.append("缺少本次 DATA_PROFILE 绿色区坐标客户总数证据")
    else:
        coordinate_ok = _contains_number_after_label(
            body, coordinate_green, ("坐标客户数",), max_gap=24,
        ) or _contains_number_before_label(
            body, coordinate_green, ("个坐标客户",), max_gap=8,
        )
        if not coordinate_ok:
            issues.append("正文未引用本次绿色区坐标客户总数")

    exact = verified_structured_map(state, "SMALL_EXACT")
    required_exact = ("customers", "exact_distance", "heuristic_distance", "gap_pct")
    if not all(key in exact for key in required_exact):
        issues.append("缺少本次 SMALL_EXACT 精确对照证据")
    else:
        exact_checks = (
            ("customers", ("等距抽取的", "Held–Karp 对"), ("精确距离", "2-opt", "偏差")),
            ("exact_distance", ("精确距离",), ("2-opt", "启发式距离", "偏差")),
            ("heuristic_distance", ("最近邻加2-opt为", "2-opt启发式距离"), ("精确距离", "偏差")),
            ("gap_pct", ("偏差", "差距"), ("精确距离", "启发式距离")),
        )
        for key, labels, blockers in exact_checks:
            suffix = "%" if key == "gap_pct" else ""
            if not _contains_number_after_label(
                body,
                exact[key],
                labels,
                suffix=suffix,
                max_gap=36,
                blockers=blockers,
            ):
                issues.append(f"正文未引用本次 SMALL_EXACT 指标 {key}")
    return issues
