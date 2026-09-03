import pytest
from math_agent.state import (
    MathModelingState, PaperSections, FigureArtifact, SensitivityRun,
    CriticReport, EvaluationReport, ModelCodeConsistencyReport, CodeArtifact,
)
from math_agent.nodes.evaluation import _offline_evaluation, evaluation_node
from math_agent.nodes.paper_evidence import factorial_effect_percentages


def _full_state():
    s = MathModelingState(problem="p")
    s.paper = PaperSections(
        abstract="a"*200, problem_restatement="x"*200, assumptions="x"*200,
        notation="x"*200, model_section="x"*200, solution="x"*200,
        sensitivity="x"*200, conclusion="x"*200, references="-",
    )
    s.figures.append(FigureArtifact(path="a.png", purpose="t", quality_score=8))
    s.sensitivity_runs.append(SensitivityRun(parameter="a", values=[1], metric="m", results=[1]))
    s.critic_reports.extend([
        CriticReport(target="modeler", stage="final", score=8, approved=True),
        CriticReport(target="paper", score=9, approved=True),
    ])
    s.model_code_reports.append(ModelCodeConsistencyReport(score=8, approved=True))
    return s


def _attach_offline_evidence(state):
    state.code_artifacts.append(CodeArtifact(
        purpose="main",
        code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        success=True,
        evidence_role="primary",
        stdout=(
            "SCENARIO_Q1: baseline=no_policy total_cost=90685.60\n"
            "RESULT: baseline=ours total_cost=91544.49 vehicles=123 "
            "service_rate=1 total_carbon=999 timewin_rate=0.9333 "
            "dynamic_cost_increase_ratio=0.00544301\n"
            "DYNAMIC_STRESS: samples=30 success=21 success_rate=0.7\n"
            "DATA_PROFILE: green_customers=12 coordinate_green_customers=15\n"
            "SMALL_EXACT: customers=8 exact_distance=242.42 "
            "heuristic_distance=251.28 gap_pct=3.65\n"
        ),
    ))
    interaction = SensitivityRun(
        parameter="速度比例×限行开始时刻二维组合编码",
        values=[8007, 8008, 8009, 10007, 10008, 10009, 12007, 12008, 12009],
        metric="total_cost",
        results=[
            94541.15, 92673.57, 92817.31,
            92704.02, 91544.49, 91425.33,
            92301.92, 91006.45, 90933.57,
        ],
    )
    state.sensitivity_runs.append(interaction)
    state.sensitivity_formal_parameters = [interaction.parameter]
    return factorial_effect_percentages(interaction)


def test_evaluation_returns_report(mocker):
    fake = EvaluationReport(
        assumption_reasonableness=8, modeling_creativity=8,
        result_correctness=8, writing_clarity=8, extra_depth=8, overall=8.0,
        issues=[], suggestions=[],
    )
    mocker.patch("math_agent.nodes.evaluation.complete", return_value=fake)
    delta = evaluation_node(_full_state())
    assert isinstance(delta["evaluation"], EvaluationReport)
    assert delta["evaluation"].overall == 8.0


def test_evaluation_recomputes_overall_if_llm_wrong(mocker):
    fake = EvaluationReport(
        assumption_reasonableness=8, modeling_creativity=8,
        result_correctness=8, writing_clarity=8, extra_depth=8, overall=10.0,
    )
    mocker.patch("math_agent.nodes.evaluation.complete", return_value=fake)
    delta = evaluation_node(_full_state())
    assert delta["evaluation"].overall == pytest.approx(8.0, abs=0.01)


def test_evaluation_skips_without_paper(mocker):
    s = MathModelingState(problem="p")
    delta = evaluation_node(s)
    assert delta["errors"]
    assert delta.get("evaluation") is None


def test_evaluation_caps_correctness_without_upstream_quality(mocker):
    state = _full_state()
    state.critic_reports = [
        report for report in state.critic_reports if report.target == "paper"
    ]
    state.model_code_reports = []
    fake = EvaluationReport(
        assumption_reasonableness=9, modeling_creativity=9,
        result_correctness=9, writing_clarity=9, extra_depth=9, overall=9.0,
    )
    mocker.patch("math_agent.nodes.evaluation.complete", return_value=fake)

    report = evaluation_node(state)["evaluation"]

    assert report.modeling_creativity == 6
    assert report.result_correctness == 5
    assert report.overall < 8


def test_offline_evaluation_scores_only_present_evidence():
    state = _full_state()
    effects = _attach_offline_evidence(state)
    assert effects is not None
    state.paper = PaperSections(
        assumptions="假" * 700,
        model_section=(
            r"\mathcal G_{k,h} 连续限行 " + "模" * 3000
        ),
        solution=(
            "Q1总成本90685.60，主方案总成本91544.49，"
            "代理成本相对静态总成本之比为0.00544301。不等于备用车辆启用率为零 "
                "Held–Karp 碳排机制 Q1无政策方案 无邻域与发车优化 "
                "题面文字称绿色区有30个客户，附件口径下有12个当日正需求客户，"
                "半径内共有15个坐标客户 "
            + "解" * 4000
        ),
        sensitivity=(
            f"3×3全因子 描述性双因素平方和分解，速度主效应贡献率{effects[0]:.2f}%，"
            f"限行开始时刻主效应贡献率{effects[1]:.2f}%，"
            f"不可加交互残差贡献率{effects[2]:.2f}%。蒙特卡洛 "
            + "敏" * 1000
        ),
        conclusion=(
            "30个移动任务压力样本成功21次，70%成功率。连续事件；"
            "Held–Karp 对8客户精确距离242.42，2-opt启发式距离251.28，"
            "偏差3.65%。" + "结" * 1500
        ),
    )

    report = _offline_evaluation(state)

    assert report.overall >= 8
    assert report.result_correctness == 9

    state.code_artifacts[0].stdout = state.code_artifacts[0].stdout.replace(
        "total_cost=91544.49", "total_cost=99999.99",
    )
    stale = _offline_evaluation(state)
    assert stale.result_correctness == 6
    assert any("99999.99" in issue for issue in stale.issues)

    state.paper.sensitivity += " 模拟退火"
    rejected = _offline_evaluation(state)
    assert rejected.writing_clarity == 6
