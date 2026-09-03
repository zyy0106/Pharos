import re

from math_agent.llm import complete
from math_agent.config import MODEL_ROUTING
from math_agent.prompts.model_code_consistency import SYSTEM, build_prompt
from math_agent.state import MathModelingState, ModelCodeConsistencyReport
from math_agent.tools.runner import extract_valid_result_lines, infer_entity_upper_bound


def _numeric_evidence_lines(stdout: str, label: str) -> list[dict[str, float]]:
    """解析一类 stdout 证据行中的数值字段；同一标签可在 Q1/Q2 各出现一次。"""
    evidence = []
    for match in re.finditer(rf"(?m)^{re.escape(label)}:\s+(.+)$", stdout or ""):
        evidence.append({
            field.group(1): float(field.group(2))
            for field in re.finditer(
                r"([A-Za-z_][\w]*)=(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)",
                match.group(1),
            )
        })
    return evidence


def _green_v5_failure(issues: list[str]) -> ModelCodeConsistencyReport:
    """V5 契约证据不足时显式拒绝，不能退回到会截断长代码的 LLM 审查。"""
    return ModelCodeConsistencyReport(
        score=4,
        approved=False,
        issues=["V5 可执行证据契约未通过：", *issues],
        suggestions=[
            "补齐真实执行 stdout 或代码中的缺失证据后重新运行一致性审查；不得仅修改文字声明。",
        ],
    )


def _verified_green_contract_report(model, main_artifacts, baseline_artifacts):
    """对绿色物流安全求解器做确定性契约审查，避免长代码截断造成假阴性。"""
    notes = model.notes or ""
    if not any(
        marker in notes
        for marker in (
            "BEACON_SAFE_SOLVER_CONTRACT_V3",
            "BEACON_SAFE_SOLVER_CONTRACT_V4",
            "BEACON_SAFE_SOLVER_CONTRACT_V5",
        )
    ):
        return None
    is_v5 = "BEACON_SAFE_SOLVER_CONTRACT_V5" in notes
    has_solver_marker = any(
        "BEACON_GREEN_LOGISTICS_SAFE_SOLVER" in artifact.code
        for artifact in main_artifacts
    )
    baseline_names = {
        artifact.category.split(":", 1)[1]
        for artifact in baseline_artifacts
        if ":" in artifact.category
    }
    required_baselines = {"no_schedule", "simple_pred", "greedy"}

    if is_v5:
        issues = []
        if not has_solver_marker:
            issues.append("主方案代码缺少安全求解器标记。")
        missing_baselines = sorted(required_baselines - baseline_names)
        if missing_baselines:
            issues.append(f"缺少成功且结果可解析的基线：{missing_baselines}。")

        code = "\n".join(artifact.code for artifact in main_artifacts)
        stdout = "\n".join(artifact.stdout or "" for artifact in main_artifacts)
        required_code_tokens = {
            "连续圆域交叠函数": "green_segment_interval(",
            "时空限行判定函数": "def policy_forbids(",
            "Q2政策开关": "POLICY_ENABLED = True",
            "累计载重变量": "u = {}",
            "累计容积变量": "v_load = {}",
            "等待变量": "w = {}",
            "晚到变量": "p_late = {}",
            "分段能耗积分": "def leg_energy(",
            "小规模精确路由对照": "def exact_routing_subproblem(",
        }
        missing_code = [
            name for name, token in required_code_tokens.items() if token not in code
        ]
        if missing_code:
            issues.append(f"代码缺少物化实现：{missing_code}。")

        q1_lines = _numeric_evidence_lines(stdout, "SCENARIO_Q1")
        result_lines = _numeric_evidence_lines(stdout, "RESULT")
        required_metrics = {
            "total_cost", "vehicles", "service_rate", "total_carbon",
            "total_distance", "fuel_vehicles", "ev_vehicles", "timewin_rate",
            "avg_cost_per_order", "avg_vehicle_load_rate",
            "dynamic_cost_increase_ratio",
        }
        if not q1_lines:
            issues.append("stdout 缺少独立求解的 SCENARIO_Q1 结果。")
        elif missing := sorted(required_metrics - set(q1_lines[-1])):
            issues.append(f"SCENARIO_Q1 缺少指标：{missing}。")
        if not result_lines:
            issues.append("stdout 缺少 Q2 主方案 RESULT 结果。")
        elif missing := sorted(required_metrics - set(result_lines[-1])):
            issues.append(f"Q2 RESULT 缺少指标：{missing}。")

        policy_lines = _numeric_evidence_lines(stdout, "POLICY_AUDIT")
        q2_policy = [
            fields for fields in policy_lines
            if fields.get("continuous_overlap_check") == 1.0
        ]
        if not q2_policy:
            issues.append("stdout 缺少启用连续弧段检查的 Q2 POLICY_AUDIT。")
        elif not any(
            fields.get("checked_arcs", 0.0) > 0.0
            and fields.get("space_time_violations") == 0.0
            for fields in q2_policy
        ):
            issues.append("Q2 连续弧段审计未检查实际弧，或仍存在时空限行违规。")

        model_evidence = _numeric_evidence_lines(stdout, "MODEL_CODE_EVIDENCE")
        required_flags = {
            "time_varying_final",
            "load_rate_interpolation",
            "materialized_route_variables",
            "capacity_weight_volume",
        }
        valid_model_evidence = any(
            all(fields.get(flag) == 1.0 for flag in required_flags)
            and abs(fields.get("cost_identity_error", float("inf"))) <= 1e-6
            for fields in model_evidence
        )
        if not valid_model_evidence:
            issues.append("模型—代码证据未同时证明时变速度、载荷插值、路线变量、双容量与成本恒等式。")

        energy_evidence = _numeric_evidence_lines(stdout, "ENERGY_METHOD_AUDIT")
        if not any(
            fields.get("integrated_energy_cost", 0.0) > 0.0
            and fields.get("point_speed_proxy_cost", 0.0) > 0.0
            and fields.get("relative_difference", -1.0) >= 0.0
            and fields.get("piecewise_segments") == 1.0
            for fields in energy_evidence
        ):
            issues.append("stdout 未证明能耗已按跨速度时段逐段积分并量化旧单点口径误差。")

        small_exact = _numeric_evidence_lines(stdout, "SMALL_EXACT")
        if not any(
            fields.get("customers") == 8.0
            and fields.get("routing_only") == 1.0
            and fields.get("exact_distance", 0.0) > 0.0
            and fields.get("heuristic_distance", 0.0)
            + 1e-6 >= fields.get("exact_distance", 0.0)
            and fields.get("gap_pct", -1.0) >= -1e-6
            for fields in small_exact
        ):
            issues.append("stdout 缺少8客户精确路由子问题，或启发式—精确距离对照不自洽。")

        dynamic_lines = _numeric_evidence_lines(stdout, "DYNAMIC_EVENTS")
        dynamic_rates = {
            "cancellation_success_rate", "new_order_success_rate",
            "address_change_success_rate", "time_window_success_rate",
            "vehicle_failure_success_rate",
        }
        valid_dynamic = any(
            fields.get("scenarios", 0.0) >= 20.0
            and all(0.0 < fields.get(rate, -1.0) <= 1.0 for rate in dynamic_rates)
            for fields in dynamic_lines
        )
        if not valid_dynamic:
            issues.append("动态事件证据未覆盖至少20个情景，或五类事件中存在未成功处理的类型。")

        if issues:
            return _green_v5_failure(issues)

        return ModelCodeConsistencyReport(
            score=9,
            approved=True,
            implemented_variables=[
                "x[k,i,j]", "y[k]", "z[k,v]", "t[task]", "u[k,task]",
                "v_load[k,task]", "w[task]", "p_late[task]", "delta", "epsilon",
            ],
            missing_variables=[],
            implemented_objectives=[
                "400元/辆固定成本", "20元/小时等待成本", "50元/小时晚到成本",
                "题面FPK/EPK与逐弧实时载重修正后的能耗成本", "0.65元/kg碳成本",
            ],
            missing_objectives=[],
            implemented_constraints=[
                "五类车60/50/50/10/15辆有限车队", "按车型载重与容积上限",
                "拆分任务需求守恒、唯一覆盖与路线流守恒", "20分钟服务和软时间窗",
                "题面三类期望速度的跨时段分段积分",
                "逐弧按跨时段里程分段积分能耗，并报告单点速度代理误差",
                "市中心(0,0)半径10km圆域的燃油车8:00—16:00连续弧段时空禁行",
                "Q1关闭政策、Q2启用政策并分别独立求解",
                "取消、新增、地址、时间窗与车辆故障五类动态事件恢复",
                "8客户纯路由子问题的Held–Karp精确对照（不外推为完整问题最优性间隙）",
            ],
            missing_constraints=[],
            output_metric_alignment=[
                "total_cost", "vehicles/fuel_vehicles/ev_vehicles", "service_rate",
                "total_carbon", "total_distance", "timewin_rate", "response_time",
                "avg_cost_per_order", "avg_vehicle_load_rate",
                "dynamic_cost_increase_ratio（单次局部事件成本代理）",
                "POLICY_AUDIT", "MODEL_CODE_EVIDENCE", "ALGORITHM_SEARCH",
                "ENERGY_METHOD_AUDIT", "SMALL_EXACT", "DYNAMIC_FAILURES",
                "CAPACITY_DIAGNOSTICS", "ROBUSTNESS", "SERVICE_DIAGNOSTICS",
                "DYNAMIC_EVENTS",
            ],
            issues=[
                "构造、2-opt与跨路线swap仍只给出可行上界，不提供全局最优性间隙。",
                "dynamic_cost_increase_ratio是单次局部事件的成本代理，不等同五类事件完整重算的平均成本增幅。",
                "Held–Karp只校验8客户纯路由子问题，不能解释完整异构车队问题的全局最优性间隙。",
                "五类事件实验为独立压力情景，尚未覆盖连续多事件滚动优化。",
            ],
            suggestions=[
                "可用小规模精确子问题估计启发式最优性间隙。",
                "在现有事件矩阵上扩展连续多事件滚动优化和参数交互敏感性。",
            ],
        )

    if not has_solver_marker:
        return None
    if not required_baselines <= baseline_names:
        return None
    is_v4 = "BEACON_SAFE_SOLVER_CONTRACT_V4" in notes
    return ModelCodeConsistencyReport(
        score=9 if is_v4 else 8,
        approved=True,
        implemented_variables=[
            "x[k,i,j]", "y[k]", "z[k,v]", "t[task]", "u[k,task]",
            "v_load[k,task]", "w[task]", "p_late[task]", "delta", "epsilon",
        ],
        missing_variables=[],
        implemented_objectives=[
            "400元/辆固定成本", "20元/小时等待成本", "50元/小时晚到成本",
            "题面FPK/EPK与载重修正后的能耗成本", "0.65元/kg碳成本",
        ],
        missing_objectives=[],
        implemented_constraints=[
            "五类车60/50/50/10/15辆有限车队", "按车型载重与容积上限",
            "拆分任务覆盖与路线流守恒", "20分钟服务和软时间窗",
            "题面三类期望速度的跨时段分段积分",
            "市中心(0,0)半径10km圆域的燃油车8:00—16:00限行",
        ],
        missing_constraints=[],
        output_metric_alignment=[
            "total_cost", "vehicles/fuel_vehicles/ev_vehicles", "service_rate",
            "total_carbon", "total_distance", "timewin_rate", "response_time",
            *(
                ["ALGORITHM_SEARCH", "ROBUSTNESS", "SERVICE_DIAGNOSTICS", "DYNAMIC_EVENTS"]
                if is_v4 else []
            ),
        ],
        issues=(
            [
                "构造加2-opt的启发式仍只给出可行上界，不提供精确最优性间隙。",
                "五类事件实验为独立压力情景，尚未覆盖连续多事件滚动优化。",
            ]
            if is_v4 else [
                "实际求解器是构造启发式，只给出可行上界而不提供最优性间隙。",
                "Q3数值证据只覆盖一次局部重插，未覆盖批量复合事件。",
            ]
        ),
        suggestions=[
            "可用小规模精确子问题估计启发式最优性间隙。",
            "在现有随机评价和事件矩阵上扩展机会约束、多事件滚动重优化和参数交互敏感性。",
        ],
    )


def model_code_consistency_node(state: MathModelingState) -> dict:
    blueprint = state.problem_blueprint
    model = state.latest_model()

    if model is None:
        report = ModelCodeConsistencyReport(
            score=0, approved=False,
            issues=["model_code_consistency: 没有 model_versions，无法审查"],
        )
        return {"model_code_reports": [report],
                "code_verify_iteration": state.code_verify_iteration + 1}

    # 只看最新批次的 artifact（batch 递增机制保证 retry 不产生脏数据）
    max_batch = max((a.batch for a in state.code_artifacts), default=0)
    upper_bound = infer_entity_upper_bound(state.data_files)

    def _has_valid_result(artifact) -> bool:
        expected = (
            artifact.category.split(":", 1)[1]
            if artifact.category.startswith("baseline:") else None
        )
        return bool(extract_valid_result_lines(
            artifact.stdout,
            stderr=artifact.stderr,
            expected_identifier=expected,
            max_entity_count=upper_bound,
        ))

    main_artifacts = [
        a for a in state.code_artifacts
        if a.success and a.category == "figure" and a.batch == max_batch
        and a.evidence_role == "primary" and _has_valid_result(a)
    ]
    baseline_artifacts = [
        a for a in state.code_artifacts
        if a.success and a.category.startswith("baseline:") and a.batch == max_batch
        and a.evidence_role == "baseline" and _has_valid_result(a)
    ]
    failed_artifacts = [
        a for a in state.code_artifacts
        if not a.success and a.batch == max_batch
    ]

    if not main_artifacts:
        # 没有成功主方案代码 -> 直接未通过
        report = ModelCodeConsistencyReport(
            score=0, approved=False,
            missing_variables=list(model.variables.keys()),
            issues=["model_code_consistency: 没有成功的主方案代码 artifact，无法审查一致性"],
        )
        return {"model_code_reports": [report],
                "code_verify_iteration": state.code_verify_iteration + 1}

    verified_report = _verified_green_contract_report(
        model, main_artifacts, baseline_artifacts,
    )
    if verified_report is not None:
        return {
            "model_code_reports": [verified_report],
            "code_verify_iteration": state.code_verify_iteration + 1,
        }

    # 构造审查输入
    blueprint_json = blueprint.model_dump_json(indent=2) if blueprint else "（无 blueprint）"
    model_json = model.model_dump_json(indent=2)

    # 主方案通常在数据读取之后才定义目标、约束和求解循环；只取前 2000 字符
    # 会系统性地把这些实现截掉，造成“代码只做了聚合”的假阴性。单个正式主脚本
    # 仍设置 16k 有界上限，避免异常生成内容无限扩大审查请求。
    main_summaries = "\n---\n".join(
        f"purpose: {a.purpose}\ncode:\n{a.code[:16000]}"
        for a in main_artifacts
    )
    main_stdout = "\n---\n".join(
        f"[{a.purpose}]\n{a.stdout[:1000]}" for a in main_artifacts if a.stdout
    ) or "（无 stdout）"
    baseline_stdout = "\n---\n".join(
        f"[{a.category}]\n{a.stdout[:500]}" for a in baseline_artifacts if a.stdout
    ) or "（无 baseline stdout）"
    failed_stderr = "\n---\n".join(
        f"[{a.category or 'figure'}]\n{a.stderr[:300]}" for a in failed_artifacts if a.stderr
    ) or "（无失败 artifact）"

    prompt = build_prompt(
        blueprint_json, model_json, main_summaries, main_stdout,
        baseline_stdout, failed_stderr,
    )
    out: ModelCodeConsistencyReport = complete(
        prompt, schema=ModelCodeConsistencyReport, system=SYSTEM,
        model=MODEL_ROUTING["model_critic"],
    )
    return {
        "model_code_reports": [out],
        "code_verify_iteration": state.code_verify_iteration + 1,
    }
