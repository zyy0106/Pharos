"""Tests for math_agent.nodes.latex_node — latex_node() orchestration."""
import re

from math_agent.state import (
    MathModelingState, PaperSections, CodeArtifact, FigureArtifact, SensitivityRun,
)
from math_agent.nodes.latex_node import (
    latex_node,
    _formal_figures,
    _refresh_verified_cost_figure,
    _sensitivity_figure_analysis,
    _verified_comparison_figure,
    _green_publication_stdout,
)


def _state(workdir):
    s = MathModelingState(problem="p", output_dir=str(workdir))
    s.paper = PaperSections(
        abstract="a"*100, problem_restatement="b"*100, assumptions="c"*100,
        notation="d"*100, model_section="e"*100, solution="f"*100,
        sensitivity="g"*100, conclusion="h"*100, references="-",
    )
    return s


def test_latex_node_writes_tex_and_markdown_fallback(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": False, "pdf_path": "", "log": "no xelatex"})(),
    )
    s = _state(workdir)
    delta = latex_node(s)
    assert (workdir / "paper.tex").exists()
    assert (workdir / "paper.md").exists()
    assert delta["errors"]
    assert "no xelatex" in delta["errors"][0]


def test_latex_node_records_pdf_path_on_success(mocker, workdir):
    pdf = workdir / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": str(pdf), "log": ""})(),
    )
    s = _state(workdir)
    delta = latex_node(s)
    assert (workdir / "paper.tex").exists()
    assert delta == {} or "errors" not in delta


def test_latex_node_processes_markdown_in_paper(mocker, workdir):
    """端到端：paper 段含 ### 三级标题与 unicode 数学，渲到 tex 后两者都被处理。"""
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.paper.model_section = "### basic阶段\n参数 σ 是常数。"
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\subsubsection{basic阶段}" in tex
    assert r"$\sigma$" in tex
    assert "###" not in tex


def test_latex_node_title_only_first_line(mocker, workdir):
    """title 只取 problem 第一行，避免长问题描述塞进标题。"""
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.problem = "城市共享单车调度优化\n建立模型预测各站点未来一小时的需求量。\n在不超过 100 辆运力的前提下，设计最优调度方案。"
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\title{城市共享单车调度优化}" in tex
    assert r"建立模型预测各站点未来" not in tex.split(r"\title{")[1].split("}")[0]


def test_green_solver_uses_problem_specific_title_in_tex_and_markdown(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    state.problem = "城市应急物资调度优化"
    state.code_artifacts = [CodeArtifact(
        purpose="主方案", code="# BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        stdout="RESULT: baseline=ours total_cost=1 vehicles=1 service_rate=1 total_carbon=1",
        success=True, evidence_role="primary",
    )]

    latex_node(state)

    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    markdown = (workdir / "paper.md").read_text(encoding="utf-8")
    title = "多约束异构车队绿色配送与动态局部重调度"
    assert title in tex and markdown.startswith(f"# {title}")
    assert r"\section{计算证据摘要}" in tex
    assert r"\begin{lstlisting}[language=Python]" not in tex


def test_verified_comparison_figure_is_derived_from_result_lines(workdir):
    state = _state(workdir)
    common = " vehicles=2 service_rate=1 total_carbon=3 timewin_rate=.9"
    state.code_artifacts = [
        CodeArtifact(
            purpose="主方案", code="# BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
            stdout="RESULT: baseline=ours total_cost=100" + common,
            success=True, evidence_role="primary",
        ),
        CodeArtifact(
            purpose="贪心基线", code="print(1)", category="baseline:greedy",
            stdout="RESULT: baseline=greedy total_cost=120" + common,
            success=True, evidence_role="baseline",
        ),
    ]

    figure = _verified_comparison_figure(state, workdir)

    assert figure is not None
    assert figure.path.endswith("baseline_comparison.png")
    assert (workdir / "baseline_comparison.png").stat().st_size > 10_000


def test_green_comparison_figure_uses_q1_and_q2_primary_scenarios(workdir):
    state = _state(workdir)
    state.code_artifacts = [CodeArtifact(
        purpose="主方案",
        code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        stdout=(
            "SCENARIO_Q1: baseline=no_policy total_cost=91 total_carbon=11 "
            "timewin_rate=.93 vehicles=3 service_rate=1\n"
            "RESULT: baseline=ours total_cost=92 total_carbon=10 "
            "timewin_rate=.90 vehicles=3 service_rate=1\n"
        ),
        success=True,
        evidence_role="primary",
    )]

    figure = _verified_comparison_figure(state, workdir)

    assert figure is not None
    assert figure.path.endswith("policy_scenario_comparison.png")
    assert "问题一与问题二" in figure.purpose
    assert (workdir / "policy_scenario_comparison.png").stat().st_size > 10_000


def test_green_publication_stdout_localizes_internal_labels():
    value = (
        "RESULT: baseline=ours total_cost=92 vehicles=3 service_rate=1 total_carbon=10\n"
        "CROSS_ROUTE_SEARCH: initial_score=10 final_score=8 improvement=2 "
        "swaps=1 evaluated_moves=20\n"
        "SCENARIO_END: q2_green_policy\n"
    )

    curated = _green_publication_stdout(value)

    assert "Cross Route Search" not in curated
    assert "Scenario End" not in curated
    assert "跨路线交换" in curated
    assert "交换次数" in curated


def test_latex_node_figure_caption_truncated(mocker, workdir):
    """figure caption 截到完整句且不超过 55 字，避免半个数字结尾。"""
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.figures.append(FigureArtifact(
        path="a.png", purpose="test",
        caption="这是完整的第一句。" + "第二句包含成本占比44.0%并继续解释很长的原因" * 8,
        analysis="完整分析" * 20,
    ))
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    m = re.search(r"\\caption\{([^}]+)\}", tex)
    assert m and len(m.group(1)) <= 56
    assert m.group(1) == "这是完整的第一句。"


def test_latex_node_interleaves_figures_near_semantic_section_anchors(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    state.paper.problem_restatement = "## 数据预处理与总体路线\n数据正文。\n\n## 难点\n难点正文。"
    state.paper.solution = (
        "## 求解算法与执行流程\n算法正文。\n\n"
        "## 随机交通蒙特卡洛稳健性\n稳健性正文。"
    )
    state.figures = [
        FigureArtifact(
            path="data_profile.png", purpose="附件数据画像", caption="数据画像",
            analysis="结论上，需求与时间窗存在差异。图中分布支持容量拆分和车型选择，但不直接证明方案最优。" * 2,
        ),
        FigureArtifact(
            path="robustness_diagnostics.png", purpose="随机交通稳健性", caption="随机稳健性",
            analysis="结论上，交通扰动产生尾部风险。图中分位线支持预留缓冲，但不代表随机规划已经求解。" * 2,
        ),
    ]

    latex_node(state)

    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    markdown = (workdir / "paper.md").read_text(encoding="utf-8")
    assert "关键图表" not in tex
    assert tex.index("data_profile.png") < tex.index(r"\section{模型假设}")
    assert tex.index("robustness_diagnostics.png") > tex.index("随机交通蒙特卡洛稳健性")
    assert tex.count(r"\textbf{图示结论：}") == 2
    assert tex.count(r"\begin{minipage}{0.92\linewidth}") == 2
    assert "## 附录 B. 图表" not in markdown
    assert markdown.index("data_profile.png") < markdown.index("## 2. 模型假设")
    assert markdown.index("robustness_diagnostics.png") > markdown.index("随机交通蒙特卡洛稳健性")


def test_sensitivity_figure_analysis_states_conclusion_evidence_and_boundary():
    analysis = _sensitivity_figure_analysis(SensitivityRun(
        parameter="速度比例", values=[0.8, 1.0, 1.2], metric="总成本",
        results=[110.0, 100.0, 108.0],
    ))

    assert "非单调" in analysis
    assert "最低值 100.00" in analysis
    assert "连续响应拟合" in analysis


def test_refresh_verified_cost_figure_accepts_cost_pie_filename(workdir):
    """正式成本图沿用生成器的 cost_pie 文件名时也必须由主 RESULT 重绘。"""
    target = workdir / "cost_pie.png"
    state = _state(workdir)
    state.code_artifacts = [CodeArtifact(
        purpose="主方案",
        code="# BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
        stdout=(
            "RESULT: baseline=ours total_cost=100 vehicles=2 service_rate=1 "
            "total_carbon=3\n"
            "BREAKDOWN: Z_fix=40 Z_wait=20 Z_late=10 Z_energy=25 Z_carbon=5\n"
        ),
        success=True,
        evidence_role="primary",
        batch=1,
    )]
    figures = [FigureArtifact(
        path=str(target), purpose="成本构成饼图", caption="成本构成", analysis="",
    )]

    _refresh_verified_cost_figure(state, figures)

    assert target.is_file()
    assert target.stat().st_size > 10_000


def test_latex_node_escapes_filename_like_figure_caption(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    state.figures.append(FigureArtifact(
        path="figure.png", purpose="cost_rate & result",
        caption="sensitivity_capacity.png & comparison", analysis="分析",
    ))
    latex_node(state)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\caption{sensitivity\_capacity.png \& comparison}" in tex


def test_latex_node_escapes_title_without_html_entities(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.problem = "成本 A&B_{raw} 与参数 α\n正文"
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\title{成本 A\&B\_\{raw\} 与参数 $\alpha$}" in tex
    assert "&amp;" not in tex


def test_latex_node_escapes_code_artifact_purpose(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.code_artifacts.append(CodeArtifact(
        purpose="cost_rate & result", code="print(1)",
        stdout="RESULT: baseline=ours total_cost=1 vehicles=1 service_rate=1 total_carbon=1",
        success=True, evidence_role="primary",
    ))
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\subsection{$cost_rate$ \& result}" in tex


def test_latex_node_excludes_baseline_and_supporting_code(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    common = " total_cost=1 vehicles=1 service_rate=1 total_carbon=1"
    state.code_artifacts = [
        CodeArtifact(
            purpose="正式主求解", code="PRIMARY_SENTINEL", success=True,
            evidence_role="primary", stdout="RESULT: baseline=ours" + common,
        ),
        CodeArtifact(
            purpose="基线", code="BASELINE_SENTINEL", success=True,
            evidence_role="baseline", category="baseline:greedy",
            stdout="RESULT: baseline=greedy" + common,
        ),
        CodeArtifact(
            purpose="补充图", code="SUPPORTING_SENTINEL", success=True,
            evidence_role="supporting", stdout="RESULT: baseline=ours" + common,
        ),
    ]

    latex_node(state)

    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    markdown = (workdir / "paper.md").read_text(encoding="utf-8")
    assert "PRIMARY_SENTINEL" in tex and "PRIMARY_SENTINEL" in markdown
    assert "BASELINE_SENTINEL" not in tex and "BASELINE_SENTINEL" not in markdown
    assert "SUPPORTING_SENTINEL" not in tex and "SUPPORTING_SENTINEL" not in markdown


def test_formal_figures_excludes_green_supporting_and_algorithm_flow(workdir):
    state = _state(workdir)
    main_path = str(workdir / "data_profile.png")
    flow_path = str(workdir / "algorithm_flow.png")
    supporting_path = str(workdir / "supporting.png")
    state.code_artifacts = [
        CodeArtifact(
            purpose="main", code="BEACON_GREEN_LOGISTICS_SAFE_SOLVER",
            success=True, evidence_role="primary",
            artifact_paths=[main_path, flow_path],
        ),
        CodeArtifact(
            purpose="support", code="", success=True, evidence_role="supporting",
            artifact_paths=[supporting_path],
        ),
    ]
    state.figures = [
        FigureArtifact(path=main_path, purpose="data"),
        FigureArtifact(path=flow_path, purpose="flow"),
        FigureArtifact(path=supporting_path, purpose="support"),
    ]

    figures = _formal_figures(state, [])

    assert [figure.path for figure in figures] == [main_path]


def test_latex_node_uses_only_latest_sensitivity_evidence(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    old = workdir / "old.png"
    current = workdir / "current.png"
    old.write_bytes(b"old")
    current.write_bytes(b"current")
    state.sensitivity_runs = [
        SensitivityRun(
            parameter="speed", values=[0.8, 1.0, 1.2], metric="cost",
            results=[240000, 245000, 250000], interpretation="STALE_INTERPRETATION",
            figure_path=str(old),
        ),
        SensitivityRun(
            parameter="speed", values=[0.8, 1.0, 1.2], metric="cost",
            results=[146017.04, 144586.99, 145204.85],
            interpretation="CURRENT_INTERPRETATION", figure_path=str(current),
        ),
    ]
    state.figures = [FigureArtifact(
        path=str(old), purpose="old", caption="STALE_CAPTION", analysis="STALE_ANALYSIS",
    )]

    latex_node(state)

    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    markdown = (workdir / "paper.md").read_text(encoding="utf-8")
    assert "CURRENT_INTERPRETATION" in tex
    assert "current.png" in tex
    assert "STALE_INTERPRETATION" not in tex
    assert "STALE_CAPTION" not in tex
    assert "STALE_ANALYSIS" not in tex
    assert "CURRENT_INTERPRETATION" in markdown
    assert "current.png" in markdown
    assert "STALE_INTERPRETATION" not in markdown
    assert "STALE_CAPTION" not in markdown
    assert "STALE_ANALYSIS" not in markdown


def test_latex_node_excludes_parameters_retired_from_current_sensitivity_plan(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    retired = workdir / "retired.png"
    formal = workdir / "formal.png"
    retired.write_bytes(b"old")
    formal.write_bytes(b"new")
    state.sensitivity_runs = [
        SensitivityRun(
            parameter="retired_speed", values=[.8, 1, 1.2], metric="cost",
            results=[3, 2, 1], interpretation="RETIRED_PARAMETER",
            figure_path=str(retired),
        ),
        SensitivityRun(
            parameter="interaction", values=[1, 2, 3], metric="cost",
            results=[4, 3, 2], interpretation="FORMAL_PARAMETER",
            figure_path=str(formal),
        ),
    ]
    state.sensitivity_formal_parameters = ["interaction"]

    latex_node(state)

    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert "formal.png" in tex
    assert "retired.png" not in tex
    assert "RETIRED_PARAMETER" not in tex


def test_gmcm_references_are_rendered_as_bibitems(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.latex_template = "gmcm"
    s.paper.references = "[1] Author A. Title A.\n[2] Author B. Title B."
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\bibitem{ref1} Author A. Title A." in tex
    assert r"\bibitem{ref2} Author B. Title B." in tex
    assert "\\schoolname{None}" not in tex
    assert r"\schoolname{XX大学}" in tex


def test_default_references_are_rendered_as_numbered_list(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    state = _state(workdir)
    state.paper.references = "[1] Author A. Title A. [2] Author B. Title B."

    latex_node(state)

    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\renewcommand{\labelenumi}{[\arabic{enumi}]}" in tex
    assert r"\item Author A. Title A." in tex
    assert r"\item Author B. Title B." in tex


def test_gmcm_metadata_is_latex_escaped(mocker, workdir):
    mocker.patch(
        "math_agent.nodes.latex_node.compile_latex",
        return_value=type("R", (), {"success": True, "pdf_path": "", "log": ""})(),
    )
    s = _state(workdir)
    s.latex_template = "gmcm"
    s.school = "A&B_University"
    s.team_id = "T#1"
    s.members = "张_三,李&四,王%五"
    s.paper.keywords = "优化_调度 & 鲁棒"
    latex_node(s)
    tex = (workdir / "paper.tex").read_text(encoding="utf-8")
    assert r"\schoolname{A\&B\_University}" in tex
    assert r"\baominghao{T\#1}" in tex
    assert r"\membera{张\_三}" in tex
    assert r"\keywords{优化\_调度 \& 鲁棒}" in tex
