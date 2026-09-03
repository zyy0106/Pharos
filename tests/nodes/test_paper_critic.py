from math_agent.state import (
    MathModelingState, PaperSections, FigureArtifact, SensitivityRun, CriticReport,
    CodeArtifact, ModelCodeConsistencyReport,
)
from math_agent.nodes.paper_critic import _offline_paper_review, paper_critic_node
from math_agent.nodes.paper_evidence import factorial_effect_percentages
from math_agent.prompts.paper_critic import build_prompt


def _attach_upstream_quality(state):
    state.critic_reports.append(CriticReport(
        target="modeler", stage="final", score=8, approved=True,
    ))
    state.model_code_reports.append(
        ModelCodeConsistencyReport(score=8, approved=True)
    )


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


def test_paper_critic_appends_report(mocker):
    fake = CriticReport(target="paper", score=9, issues=[], suggestions=[], approved=True)
    mocker.patch("math_agent.nodes.paper_critic.complete", return_value=fake)
    s = MathModelingState(problem="p")
    s.paper = PaperSections(
        abstract="a"*200, problem_restatement="b"*200, assumptions="c"*200,
        notation="d"*200, model_section="e"*200, solution="f"*200,
        sensitivity="g"*200, conclusion="h"*200, references="-",
    )
    s.figures.append(FigureArtifact(path="x.png", purpose="t"))
    s.sensitivity_runs.append(SensitivityRun(
        parameter="a", values=[1], metric="m", results=[1],
    ))
    _attach_upstream_quality(s)
    delta = paper_critic_node(s)
    assert delta["critic_reports"][0].target == "paper"
    assert delta["critic_reports"][0].approved is True


def test_paper_critic_handles_missing_paper(mocker):
    s = MathModelingState(problem="p")
    delta = paper_critic_node(s)
    assert delta["errors"]
    assert delta["critic_reports"][0].score == 0
    assert delta["critic_reports"][0].approved is False


def _paper_with_numbers():
    return PaperSections(
        abstract="目标成本52.6（放缩因子22.12，对应实际成本718）。",
        problem_restatement="x"*200, assumptions="x"*200, notation="x"*200,
        model_section="x"*200, solution="x"*200, sensitivity="x"*200,
        conclusion="x"*200, references="-",
    )


def test_prompt_includes_code_stdout_block():
    """build_prompt 第 4 个形参 code_stdout：注入 stdout 文本块。"""
    real_stdout = "优化成功，目标总成本 = 52.7174\n扰动 +20% → 目标成本 53.7718"
    prompt = build_prompt(_paper_with_numbers(), 0, 0, real_stdout)
    assert "52.7174" in prompt
    assert "53.7718" in prompt
    assert "代码运行" in prompt or "stdout" in prompt.lower()


def test_prompt_omits_stdout_block_when_empty():
    """没有 success=True code_artifact 时不渲染 stdout 区块（避免噪声）。"""
    prompt = build_prompt(_paper_with_numbers(), 0, 0, "")
    assert "代码运行真实输出" not in prompt


def test_prompt_keeps_evidence_beyond_old_4000_character_cutoff():
    evidence = "A" * 5000 + "\nROBUSTNESS: scenarios=200 cost_p95=99730.48"
    prompt = build_prompt(_paper_with_numbers(), 0, 0, evidence)
    assert "cost_p95=99730.48" in prompt


def test_paper_critic_node_passes_all_valid_result_evidence(mocker):
    """评审与 writer 使用同一批有效 RESULT，失败或无协议输出均不进入 prompt。"""
    captured = {}

    def _capture(prompt, **kw):
        captured["prompt"] = prompt
        return CriticReport(target="paper", score=7, issues=[], suggestions=[], approved=False)

    mocker.patch("math_agent.nodes.paper_critic.complete", side_effect=_capture)
    s = MathModelingState(problem="p")
    s.paper = _paper_with_numbers()
    s.code_artifacts.append(CodeArtifact(purpose="x", code="...", success=False,
                                          stdout="OLD_FAILED", stderr="error"))
    s.code_artifacts.append(CodeArtifact(purpose="y", code="...", success=True,
                                          stdout="RESULT: baseline=ours total_cost=52.7174 service_rate=0.95", stderr=""))
    s.code_artifacts.append(CodeArtifact(
        purpose="z", code="...", success=True,
        stdout="RESULT: baseline=greedy total_cost=60 service_rate=0.90",
        category="baseline:greedy",
    ))
    delta = paper_critic_node(s)
    assert delta["critic_reports"][0].target == "paper"
    assert "total_cost=52.7174" in captured["prompt"]
    assert "baseline=greedy" in captured["prompt"]
    assert "OLD_FAILED" not in captured["prompt"]


def test_paper_critic_node_passes_primary_depth_evidence(mocker):
    captured = {}

    def _capture(prompt, **kw):
        captured["prompt"] = prompt
        return CriticReport(target="paper", score=9, issues=[], suggestions=[], approved=True)

    mocker.patch("math_agent.nodes.paper_critic.complete", side_effect=_capture)
    state = MathModelingState(problem="p")
    state.paper = _paper_with_numbers()
    _attach_upstream_quality(state)
    state.code_artifacts.append(CodeArtifact(
        purpose="main",
        code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        success=True,
        evidence_role="primary",
        stdout=(
            "SCENARIO_BEGIN: q1_no_policy\n"
            "SCENARIO_Q1: baseline=no_policy total_cost=91\n"
            "BREAKDOWN: Z_fix=40 Z_wait=1 Z_late=2 Z_energy=40 Z_carbon=8\n"
            "ROBUSTNESS: scenarios=200 seed=2026 cost_p95=99\n"
            "SCENARIO_END: q1_no_policy\n"
            "SCENARIO_BEGIN: q2_green_policy\n"
            "RESULT: baseline=ours total_cost=92 service_rate=1\n"
            "CROSS_ROUTE_SEARCH: improvement=9 swaps=2\n"
            "SCENARIO_END: q2_green_policy\n"
        ),
    ))

    paper_critic_node(state)

    assert "ROBUSTNESS: scenarios=200" in captured["prompt"]
    assert "CROSS_ROUTE_SEARCH: improvement=9" in captured["prompt"]


def test_paper_critic_deterministically_rejects_internal_runtime_terms(mocker):
    fake = CriticReport(target="paper", score=9, issues=[], suggestions=[], approved=True)
    mocker.patch("math_agent.nodes.paper_critic.complete", return_value=fake)
    state = MathModelingState(problem="p")
    state.paper = _paper_with_numbers()
    state.paper.solution = "本文结果来自 checkpoint，并回溯到 stdout。"
    _attach_upstream_quality(state)

    report = paper_critic_node(state)["critic_reports"][0]

    assert report.approved is False
    assert report.score == 7
    assert any("工程内部流程标记" in issue.problem for issue in report.issues)


def test_paper_critic_rejects_missing_upstream_quality(mocker):
    fake = CriticReport(target="paper", score=10, issues=[], suggestions=[], approved=True)
    mocker.patch("math_agent.nodes.paper_critic.complete", return_value=fake)
    state = MathModelingState(problem="p")
    state.paper = _paper_with_numbers()

    report = paper_critic_node(state)["critic_reports"][0]

    assert report.approved is False
    assert report.score == 6
    assert any("最终模型评审" in issue.problem for issue in report.issues)
    assert any("模型—代码一致性" in issue.problem for issue in report.issues)


def test_offline_paper_review_requires_concrete_quality_evidence():
    state = MathModelingState(problem="p")
    effects = _attach_offline_evidence(state)
    assert effects is not None
    state.paper = PaperSections(
        model_section=(
            r"\mathcal G_{k,h} 分段旅行时间与能耗核算 绿色区政策扩展 " + "模" * 3000
        ),
        solution=(
                "动态事件局部修复伪代码 连续限行 Q1总成本90685.60，"
                "主方案总成本91544.49，代理成本相对静态总成本之比为0.00544301。"
                "不等于备用车辆启用率为零 碳排机制 Q1无政策方案 "
                "无邻域与发车优化 题面文字称绿色区有30个客户 "
                "附件口径下绿色区有12个当日正需求客户 "
                "半径10 km内共有15个坐标客户 " + "解" * 4000
        ),
            sensitivity=(
                f"3×3全因子，速度主效应贡献率{effects[0]:.2f}%，"
                f"限行开始时刻主效应贡献率{effects[1]:.2f}%，"
                f"不可加交互残差贡献率{effects[2]:.2f}%。"
                "描述性双因素平方和分解 " + "敏" * 1000
        ),
        conclusion=(
            "30个移动任务压力样本成功21次，70%成功率。连续事件；"
            "Held–Karp 对8客户精确距离242.42，2-opt启发式距离251.28，"
            "偏差3.65%。主方案不能被宣称为成本最优 " + "结" * 1500
        ),
    )

    report = _offline_paper_review(state)

    assert report.approved is True
    assert report.score == 9

    original_solution = state.paper.solution
    state.paper.solution = (
        original_solution
        .replace("90685.60", "__Q1__")
        .replace("91544.49", "90685.60")
        .replace("__Q1__", "91544.49")
    )
    assert _offline_paper_review(state).approved is False
    state.paper.solution = original_solution

    original_conclusion = state.paper.conclusion
    state.paper.conclusion = (
        original_conclusion
        .replace("242.42", "__EXACT__")
        .replace("251.28", "242.42")
        .replace("__EXACT__", "251.28")
    )
    assert _offline_paper_review(state).approved is False
    state.paper.conclusion = original_conclusion

    state.paper.conclusion = (
        original_conclusion
        .replace("30个", "__SAMPLES__")
        .replace("21次", "30次")
        .replace("__SAMPLES__", "21个")
    )
    assert _offline_paper_review(state).approved is False
    state.paper.conclusion = original_conclusion

    state.code_artifacts.append(CodeArtifact(
        purpose="malicious-baseline",
        code="print('mixed roles')",
        success=True,
        evidence_role="baseline",
        category="baseline:greedy",
        stdout=(
            "RESULT: baseline=greedy total_cost=999\n"
            "RESULT: baseline=ours total_cost=12345\n"
        ),
    ))
    assert _offline_paper_review(state).approved is True
    state.code_artifacts.pop()

    state.code_artifacts[0].stdout = state.code_artifacts[0].stdout.replace(
        "total_cost=91544.49", "total_cost=99999.99",
    )
    stale = _offline_paper_review(state)
    assert stale.approved is False
    assert any("99999.99" in issue.problem for issue in stale.issues)

    state.paper.sensitivity += " 8007"
    rejected = _offline_paper_review(state)
    assert rejected.approved is False
    assert any("内部编码" in issue.problem for issue in rejected.issues)
