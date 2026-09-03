"""ModelCodeConsistency 节点测试。"""
from math_agent.state import (
    MathModelingState, ModelVersion, CodeArtifact, ProblemBlueprint,
    ModelCodeConsistencyReport, MetricSpec,
)
from math_agent.nodes.model_code_consistency import model_code_consistency_node


def _state_with_model_and_code(*, main_success=True, batch=1):
    s = MathModelingState(problem="p")
    s.problem_blueprint = ProblemBlueprint(
        core_task="test",
        metrics=[MetricSpec(name="total_cost", meaning="成本", direction="lower_better")],
    )
    s.model_versions.append(ModelVersion(
        stage="final", description="d" * 200, equations=["x=1"],
        variables={"x": "决策变量", "total_cost": "总成本"},
    ))
    s.code_artifacts.append(CodeArtifact(
        purpose="主方案", code="x=1\nprint('RESULT: baseline=ours total_cost=100')",
        stdout="RESULT: baseline=ours total_cost=100",
        success=main_success, category="figure", batch=batch,
    ))
    s.code_artifacts.append(CodeArtifact(
        purpose="贪心对照", code="print('RESULT: baseline=greedy total_cost=200')",
        stdout="RESULT: baseline=greedy total_cost=200",
        success=True, category="baseline:greedy", batch=batch,
    ))
    return s


def test_consistency_fails_without_final_model(mocker):
    mocker.patch("math_agent.nodes.model_code_consistency.complete",
                 return_value=ModelCodeConsistencyReport(score=9, approved=True))
    s = MathModelingState(problem="p")
    s.problem_blueprint = ProblemBlueprint(core_task="test")
    # 没有 model_versions
    delta = model_code_consistency_node(s)
    report = delta["model_code_reports"][0]
    assert report.approved is False
    assert delta["code_verify_iteration"] == 1


def test_consistency_fails_without_successful_main_code(mocker):
    """没有成功主方案代码时直接未通过。"""
    spy = mocker.patch("math_agent.nodes.model_code_consistency.complete")
    s = _state_with_model_and_code(main_success=False)
    delta = model_code_consistency_node(s)
    # 不应调用 LLM
    spy.assert_not_called()
    report = delta["model_code_reports"][0]
    assert report.approved is False
    assert "没有成功的主方案代码" in report.issues[0]
    # missing_variables 应包含模型变量
    assert "x" in report.missing_variables


def test_consistency_approves_when_aligned(mocker):
    fake = ModelCodeConsistencyReport(
        score=9, approved=True,
        implemented_variables=["x", "total_cost"],
        implemented_objectives=["minimize cost"],
        implemented_constraints=["supply=demand"],
        output_metric_alignment=["total_cost"],
    )
    mocker.patch("math_agent.nodes.model_code_consistency.complete", return_value=fake)
    s = _state_with_model_and_code()
    delta = model_code_consistency_node(s)
    report = delta["model_code_reports"][0]
    assert report.approved is True
    assert report.score == 9
    assert "x" in report.implemented_variables
    assert delta["code_verify_iteration"] == 1


def test_consistency_only_checks_latest_batch(mocker):
    """一致性审查只看最新 batch 的 artifact，不看旧 batch。"""
    spy = mocker.patch("math_agent.nodes.model_code_consistency.complete",
                       return_value=ModelCodeConsistencyReport(score=9, approved=True))
    s = _state_with_model_and_code(batch=2)
    # 添加一批旧的 artifact（batch=1）
    s.code_artifacts.insert(0, CodeArtifact(
        purpose="旧主方案", code="old code",
        stdout="RESULT: baseline=ours old=999",
        success=True, category="figure", batch=1,
    ))
    model_code_consistency_node(s)
    prompt_arg = spy.call_args.args[0]
    # 最新 batch 的代码应在 prompt 中
    assert "主方案" in prompt_arg
    # 旧 batch 的代码不应在 prompt 中
    assert "旧主方案" not in prompt_arg
    assert "old code" not in prompt_arg


def test_consistency_increments_iteration(mocker):
    mocker.patch("math_agent.nodes.model_code_consistency.complete",
                 return_value=ModelCodeConsistencyReport(score=9, approved=True))
    s = _state_with_model_and_code()
    s.code_verify_iteration = 1
    delta = model_code_consistency_node(s)
    assert delta["code_verify_iteration"] == 2


def test_consistency_prompt_includes_constraints_after_old_2000_char_cutoff(mocker):
    spy = mocker.patch(
        "math_agent.nodes.model_code_consistency.complete",
        return_value=ModelCodeConsistencyReport(score=9, approved=True),
    )
    state = _state_with_model_and_code()
    sentinel = "CAPACITY_AND_TIME_WINDOW_CONSTRAINT_SENTINEL"
    state.code_artifacts[0].code = "# data preparation\n" + ("x = 1\n" * 500) + sentinel

    model_code_consistency_node(state)

    assert sentinel in spy.call_args.args[0]


def test_verified_green_contract_corrects_prompt_hallucinations_without_llm(mocker):
    spy = mocker.patch("math_agent.nodes.model_code_consistency.complete")
    state = MathModelingState(problem="城市绿色物流")
    state.model_versions.append(ModelVersion(
        stage="final", description="有限异构车队构造启发式",
        notes="BEACON_SAFE_SOLVER_CONTRACT_V3",
    ))
    stdout = ("RESULT: baseline=ours total_cost=144586.99 vehicles=159 service_rate=1 "
              "total_carbon=14634.14 total_distance=22054.37 fuel_vehicles=134 "
              "ev_vehicles=25 timewin_rate=0.8944 response_time=0.02")
    state.code_artifacts.append(CodeArtifact(
        purpose="主方案", code="# BEACON_GREEN_LOGISTICS_SAFE_SOLVER", stdout=stdout,
        success=True, category="figure", evidence_role="primary", batch=2,
    ))
    for name in ("no_schedule", "simple_pred", "greedy"):
        state.code_artifacts.append(CodeArtifact(
            purpose=name, code="print('baseline')",
            stdout=stdout.replace("baseline=ours", f"baseline={name}"),
            success=True, category=f"baseline:{name}", evidence_role="baseline", batch=2,
        ))

    delta = model_code_consistency_node(state)

    spy.assert_not_called()
    report = delta["model_code_reports"][0]
    assert report.approved is True
    assert report.score == 8
    assert any("400元/辆" in item for item in report.implemented_objectives)
    assert any("60/50/50/10/15" in item for item in report.implemented_constraints)


def _v5_contract_state(*, policy_violations=0, include_dynamic=True):
    state = MathModelingState(problem="城市绿色物流")
    state.model_versions.append(ModelVersion(
        stage="final",
        description="连续弧段时空限行与动态滚动恢复",
        notes="BEACON_SAFE_SOLVER_CONTRACT_V5",
    ))
    code = """
# BEACON_GREEN_LOGISTICS_SAFE_SOLVER
POLICY_ENABLED = True
u = {}
v_load = {}
w = {}
p_late = {}
def green_segment_interval(a, b): ...
def policy_forbids(kind, previous, customer, departure, arrival): ...
def leg_energy(kind, leg, departure, load_ratio): ...
def exact_routing_subproblem(customer_ids): ...
"""
    metrics = (
        "total_cost=92175.42 vehicles=123 service_rate=1 total_carbon=10809.04 "
        "total_distance=16068.08 fuel_vehicles=98 ev_vehicles=25 timewin_rate=.919 "
        "avg_cost_per_order=42.4967 avg_vehicle_load_rate=.999502 "
        "dynamic_cost_increase_ratio=.00540575"
    )
    stdout = "\n".join([
        f"SCENARIO_Q1: baseline=no_policy {metrics}",
        f"RESULT: baseline=ours {metrics}",
        "POLICY_AUDIT: checked_arcs=210 "
        f"space_time_violations={policy_violations} continuous_overlap_check=1",
        "MODEL_CODE_EVIDENCE: time_varying_final=1 load_rate_interpolation=1 "
        "materialized_route_variables=1 capacity_weight_volume=1 "
        "cost_identity_error=0.0000000000",
        "ENERGY_METHOD_AUDIT: integrated_energy_cost=32394.33 "
        "point_speed_proxy_cost=32772.68 relative_difference=.011679 "
        "piecewise_segments=1",
        "SMALL_EXACT: customers=8 exact_distance=242.418793 "
        "heuristic_distance=251.276038 gap_pct=3.653695 states=3592 "
        "routing_only=1",
        *(
            ["DYNAMIC_EVENTS: scenarios=50 cancellation_success_rate=1 "
             "new_order_success_rate=1 address_change_success_rate=1 "
             "time_window_success_rate=1 vehicle_failure_success_rate=1 fallback_rate=0"]
            if include_dynamic else []
        ),
    ])
    state.code_artifacts.append(CodeArtifact(
        purpose="主方案", code=code, stdout=stdout,
        success=True, category="figure", evidence_role="primary", batch=3,
    ))
    for name in ("no_schedule", "simple_pred", "greedy"):
        state.code_artifacts.append(CodeArtifact(
            purpose=name, code="print('baseline')",
            stdout=f"RESULT: baseline={name} total_cost=100 vehicles=1",
            success=True, category=f"baseline:{name}", evidence_role="baseline", batch=3,
        ))
    return state


def test_verified_green_v5_contract_audits_full_execution_evidence_without_llm(mocker):
    spy = mocker.patch("math_agent.nodes.model_code_consistency.complete")

    delta = model_code_consistency_node(_v5_contract_state())

    spy.assert_not_called()
    report = delta["model_code_reports"][0]
    assert report.approved is True
    assert report.score == 9
    assert "avg_vehicle_load_rate" in report.output_metric_alignment
    assert any("连续弧段时空禁行" in item for item in report.implemented_constraints)


def test_verified_green_v5_contract_rejects_real_policy_violation_without_llm(mocker):
    spy = mocker.patch("math_agent.nodes.model_code_consistency.complete")

    delta = model_code_consistency_node(_v5_contract_state(policy_violations=1))

    spy.assert_not_called()
    report = delta["model_code_reports"][0]
    assert report.approved is False
    assert report.score == 4
    assert any("时空限行违规" in item for item in report.issues)


def test_verified_green_v5_contract_rejects_missing_dynamic_evidence_without_llm(mocker):
    spy = mocker.patch("math_agent.nodes.model_code_consistency.complete")

    delta = model_code_consistency_node(_v5_contract_state(include_dynamic=False))

    spy.assert_not_called()
    report = delta["model_code_reports"][0]
    assert report.approved is False
    assert any("动态事件证据" in item for item in report.issues)
