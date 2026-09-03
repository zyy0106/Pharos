from math_agent.nodes.writer import (
    _build_section_fallback,
    _build_sensitivity_text,
    _result_evidence,
    _should_use_deterministic_writer,
    _verified_abstract_problem,
    _verified_assumptions_notation,
    _verified_conclusion_section,
    _verified_model_section,
    _verified_solution,
    _verified_sensitivity_section,
    _verified_green_references,
    _verified_result_map,
    _verified_structured_map,
    _enforce_section_contract,
    render_markdown,
)
from math_agent.state import (
    CodeArtifact,
    MathModelingState,
    ModelVersion,
    SensitivityRun,
)


def _state() -> MathModelingState:
    return MathModelingState(
        problem="城市绿色物流配送调度",
        model_versions=[
            ModelVersion(
                stage="final",
                description="车辆路径与充电联合优化",
                equations=[r"\min C=\sum_{i,j}c_{ij}x_{ij}"],
                variables={"x_i_j": "车辆是否经过弧(i,j)的0-1变量"},
            )
        ],
        code_artifacts=[
            CodeArtifact(
                purpose="求解",
                code="",
                stdout=(
                    "RESULT: baseline=ours total_cost=123.4 service_rate=0.98\n"
                    r"saved=plot.png data_dir=C:\Users\demo\problem"
                ),
                success=True,
                batch=1,
            )
        ],
        sensitivity_runs=[
            SensitivityRun(
                parameter="c_v_dist",
                values=[0.8, 1.0, 1.2],
                metric="total_cost",
                results=[100.0, 110.0, 125.0],
                interpretation="成本随距离系数上升。",
            )
        ],
    )


def test_deterministic_writer_is_explicit_only(monkeypatch):
    monkeypatch.delenv("MATH_AGENT_WRITER_DETERMINISTIC", raising=False)
    assert not _should_use_deterministic_writer()
    monkeypatch.setenv("MATH_AGENT_WRITER_DETERMINISTIC", "1")
    assert _should_use_deterministic_writer()


def test_verified_green_evidence_is_scenario_aware():
    state = MathModelingState(
        problem="p",
        code_artifacts=[CodeArtifact(
            purpose="main",
            code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
            success=True,
            evidence_role="primary",
            stdout=(
                "SCENARIO_BEGIN: q1_no_policy\n"
                "SCENARIO_Q1: baseline=no_policy total_cost=91 total_carbon=11\n"
                "BREAKDOWN: Z_wait=1 Z_late=2\n"
                "SCENARIO_END: q1_no_policy\n"
                "SCENARIO_BEGIN: q2_green_policy\n"
                "RESULT: baseline=ours total_cost=92 total_carbon=10\n"
                "BREAKDOWN: Z_wait=3 Z_late=4\n"
                "SCENARIO_END: q2_green_policy\n"
            ),
        )],
    )

    metrics = _verified_result_map(state)

    assert metrics["q1_no_policy"]["total_cost"] == 91
    assert metrics["ours"]["total_cost"] == 92
    assert _verified_structured_map(state, "BREAKDOWN")["Z_wait"] == 3
    assert _verified_structured_map(
        state, "BREAKDOWN", "q1_no_policy",
    )["Z_wait"] == 1


def test_green_section_contract_restores_latex_control_characters():
    from math_agent.prompts.writer_section import schema_for_group

    state = MathModelingState(
        problem="p",
        code_artifacts=[CodeArtifact(
            purpose="main", code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
            success=True, evidence_role="primary",
        )],
    )
    section = schema_for_group("model")(
        model_section="变量 \rho 与 \theta，公式 \frac{a}{b}，系数 \beta。",
    )

    repaired = _enforce_section_contract("model", section, state)

    assert "\r" not in repaired.model_section
    assert "\t" not in repaired.model_section
    assert "\x0c" not in repaired.model_section
    assert "\x08" not in repaired.model_section
    assert r"\rho" in repaired.model_section
    assert r"\theta" in repaired.model_section
    assert r"\frac" in repaired.model_section
    assert r"\beta" in repaired.model_section


def test_green_section_contract_localizes_internal_evidence_labels():
    from math_agent.prompts.writer_section import schema_for_group

    state = MathModelingState(
        problem="p",
        code_artifacts=[CodeArtifact(
            purpose="main", code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
            success=True, evidence_role="primary",
        )],
    )
    section = schema_for_group("solution")(
        solution=(
            "ALGORITHM_SEARCH 后执行 DEPARTURE_SEARCH 与 CROSS_ROUTE_SEARCH，"
            "超过 BANEND 时记录 fallback_rate。"
        ),
    )

    repaired = _enforce_section_contract("solution", section, state)

    assert "ALGORITHM_SEARCH" not in repaired.solution
    assert "DEPARTURE_SEARCH" not in repaired.solution
    assert "CROSS_ROUTE_SEARCH" not in repaired.solution
    assert "BANEND" not in repaired.solution
    assert "fallback_rate" not in repaired.solution
    assert "路线内邻域搜索" in repaired.solution
    assert "回退率" in repaired.solution


def test_fallback_text_has_real_newlines_and_no_encoding_pollution():
    state = _state()
    for group in (
        "abstract_problem",
        "assumptions_notation",
        "model",
        "solution",
        "sensitivity",
        "conclusion",
        "references",
    ):
        output = _build_section_fallback(group, state)
        for value in output.model_dump().values():
            assert "???" not in value
            assert r"\n" not in value


def test_solution_evidence_excludes_machine_paths():
    state = _state()
    evidence = _result_evidence(state)
    assert evidence == ["RESULT: baseline=ours total_cost=123.4 service_rate=0.98"]
    assert "C:" not in "\n".join(evidence)


def test_sensitivity_names_are_markdown_code_not_raw_latex_identifiers():
    text = _build_sensitivity_text(_state())
    assert "`c_v_dist`" in text
    assert "`total_cost`" in text
    assert r"c\_v\_dist" not in text


def test_render_markdown_excludes_stale_supporting_metrics():
    state = _state()
    state.code_artifacts = [
        CodeArtifact(
            purpose="主求解", code="print('main')", success=True,
            evidence_role="primary",
            stdout="RESULT: baseline=ours total_cost=123.4 service_rate=0.98",
        ),
        CodeArtifact(
            purpose="旧补充图", code="print('stale')", success=True,
            evidence_role="supporting",
            stdout="RESULT: baseline=ours total_cost=999999 service_rate=0.01",
        ),
    ]

    markdown = render_markdown(state)

    assert "总成本=123.4" in markdown
    assert "999999" not in markdown
    assert "旧补充图" not in markdown


def test_render_markdown_demotes_embedded_section_headings():
    state = _state()
    state.paper.model_section = "## 问题一\n内容\n### 变量\n说明"

    markdown = render_markdown(state)

    assert "## 4. 模型的建立" in markdown
    assert "### 问题一" in markdown
    assert "#### 变量" in markdown
    assert "\n## 问题一" not in markdown


def test_verified_notation_contains_no_control_characters():
    section = _verified_assumptions_notation(_state())
    body = section.assumptions + section.notation

    assert r"\tau(d,t)" in body
    assert r"E_{\rm carbon}" in body
    assert not any(char in body for char in ("\x08", "\t", "\r", "\x0c"))


def test_verified_model_section_matches_executed_contract():
    text = _verified_model_section()
    assert "SERVICE_TIME" not in text
    assert "20" in text
    assert "3000" in text and "13.5" in text
    assert "(0,0)" in text
    assert "不提供全局最优性" in text
    assert "局部事件响应" in text


def test_verified_sensitivity_section_uses_checkpoint_values():
    state = _state()
    state.sensitivity_runs = [
        SensitivityRun(
            parameter="c_late", values=[50, 100, 150], metric="Z",
            results=[99, 100, 101], interpretation="单调上升。",
        ),
        SensitivityRun(
            parameter="beta_v(fuel)", values=[0.05, 0.1, 0.15], metric="Z",
            results=[90, 100, 110], interpretation="影响较强。",
        ),
        SensitivityRun(
            parameter="green_zone_radius", values=[5, 10, 15], metric="Z",
            results=[100, 100, 102], interpretation="半径扩大后上升。",
        ),
    ]

    text = _verified_sensitivity_section(state)

    assert "value/100" in text
    assert "0.1 元/kg" in text
    assert "[99.00, 100.00, 101.00]" in text
    assert "图 B.1" in text and "图 B.3" in text


def test_verified_green_paper_meets_competition_body_content_budgets():
    state = _state()
    abstract_problem = _verified_abstract_problem(state)
    assumptions_notation = _verified_assumptions_notation(state)
    sections = {
        "abstract": abstract_problem.abstract,
        "problem_restatement": abstract_problem.problem_restatement,
        "assumptions": assumptions_notation.assumptions,
        "notation": assumptions_notation.notation,
        "model_section": _verified_model_section(),
        "solution": _verified_solution(state).solution,
        "sensitivity": _verified_sensitivity_section(state),
        "conclusion": _verified_conclusion_section(state),
    }
    minimum_chars = {
        "abstract": 300,
        "problem_restatement": 1600,
        "assumptions": 1600,
        "notation": 600,
        "model_section": 4500,
        "solution": 2800,
        "sensitivity": 1800,
        "conclusion": 1600,
    }

    for field, minimum in minimum_chars.items():
        actual = len("".join(sections[field].split()))
        assert actual >= minimum, f"{field}: {actual} < {minimum}"
    assert sum(len("".join(text.split())) for text in sections.values()) >= 16000


def test_verified_green_writer_uses_profile_stress_and_domain_references():
    state = _state()
    state.code_artifacts = [CodeArtifact(
        purpose="主方案",
        code="# BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        stdout=(
            "RESULT: baseline=ours total_cost=100 vehicles=2 service_rate=1 "
            "total_carbon=3 total_distance=8 fuel_vehicles=1 ev_vehicles=1 "
            "avg_delivery_time=60 timewin_rate=1 fuel_ratio=.5 response_time=.001 "
            "dynamic_reinserted=1 dynamic_distance_change=2 dynamic_distance_improved=0\n"
            "DATA_PROFILE: order_rows=300 customers=120 active_customers=118 "
            "tasks=140 total_weight=80000 total_volume=400 green_customers=25 "
            "split_customers=18 median_window_width=240 missing_weight=0 missing_volume=0\n"
            "DYNAMIC_STRESS: samples=30 success=29 success_rate=.9667 "
            "mean_response_ms=1.2 p95_response_ms=2.4 mean_distance_change=3.5 "
            "max_distance_change=7.8 improved=4 mean_late_change=.6\n"
        ),
        success=True,
        evidence_role="primary",
    )]

    abstract = _verified_abstract_problem(state).abstract
    solution = _verified_solution(state).solution
    conclusion = _verified_conclusion_section(state)
    references = _verified_green_references()

    assert "118" in abstract and "30" in abstract
    assert "数据画像" in solution and "动态压力测试" in solution
    assert "96.67%" in solution and "29" in conclusion
    assert references.count("\n[") >= 7
    assert "Solomon" in references and "Pillac" in references


def test_verified_green_writer_explains_search_robustness_events_and_service_diagnostics():
    state = _state()
    state.code_artifacts = [CodeArtifact(
        purpose="主方案",
        code="# BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        stdout=(
            "RESULT: baseline=ours total_cost=100 vehicles=2 service_rate=1 "
            "total_carbon=3 total_distance=8 fuel_vehicles=1 ev_vehicles=1 "
            "avg_delivery_time=60 timewin_rate=.9 fuel_ratio=.5 response_time=.001 "
            "dynamic_reinserted=1 dynamic_distance_change=2 dynamic_distance_improved=0\n"
            "DATA_PROFILE: order_rows=300 customers=120 active_customers=118 tasks=140 "
            "total_weight=80000 total_volume=400 green_customers=25 split_customers=18 "
            "median_window_width=240 missing_weight=0 missing_volume=0\n"
            "DYNAMIC_STRESS: samples=30 success=20 success_rate=.6667 mean_response_ms=1.2 "
            "p95_response_ms=2.4 mean_distance_change=3.5 max_distance_change=7.8 "
            "improved=4 mean_late_change=.6\n"
            "ALGORITHM_SEARCH: initial_score=120 final_score=100 improvement=20 "
            "improvement_rate=.1667 moves=7 passes=2 runtime_ms=8.5\n"
            "ROBUSTNESS: scenarios=200 seed=2026 timewin_mean=.87 timewin_std=.03 "
            "timewin_p05=.81 late_mean=18 late_p95=31 cost_mean=108 cost_p95=121\n"
            "SERVICE_DIAGNOSTICS: late_tasks=14 mean_late_min=12 p95_late_min=27 "
            "max_late_min=42 mean_weight_util=.71 mean_volume_util=.64 "
            "empty_return_ratio=.18\n"
            "DYNAMIC_EVENTS: scenarios=50 cancellation_success_rate=1 "
            "new_order_success_rate=.72 address_change_success_rate=.58 "
            "time_window_success_rate=.66 vehicle_failure_success_rate=.40 "
            "fallback_rate=.32\n"
        ),
        success=True,
        evidence_role="primary",
    )]

    abstract = _verified_abstract_problem(state).abstract
    solution = _verified_solution(state).solution
    conclusion = _verified_conclusion_section(state)

    assert "蒙特卡洛" in abstract and "200" in abstract
    assert "2-opt" in solution and "16.67%" in solution
    assert "五类事件" in solution and "72.00%" in solution
    assert "客户与线路诊断" in solution and "42.00" in solution
    assert "P95" in conclusion and "121.00" in conclusion
