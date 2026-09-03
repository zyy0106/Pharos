"""PaperCritic：对组装好的论文初稿做整体评审，输出 CriticReport(target='paper')。"""

SYSTEM = (
    "你是国赛资深评委。请审阅一份建模论文初稿。要点："
    "（1）摘要是否凸显方法和结论；（2）假设是否被正文承接；"
    "（3）模型与求解是否一致、可复现；（4）是否有敏感性分析；"
    "（5）图表是否被正文引用并解读；（6）整体行文是否专业。"
    "（7）正文不得出现 checkpoint、stdout、artifact、attempt、RESULT、writer、runner、"
    "pipeline、门禁、正式主方案等工程内部流程标记。"
    "总评 0-10；只有达到 9 分且不存在模型—求解不一致、不可复现、关键结果无证据等问题时"
    "才能 approved=True。"
    "\n\n"
    "**关键事实核查**：若下文给出『代码运行真实输出』区块，请把它当作唯一可靠的数字事实源。"
    "用语义判断正文中的关键定量结论（成本、占比、敏感度幅度、性能指标等）是否与 stdout 相符。"
    "明显与 stdout 不符的数字（如 stdout 显示 52.7174 但正文写 718）视为编造，"
    "把它逐条列入 issues 并把 approved 设为 False。"
    "合理四舍五入（如 52.7174→52.6、53.7718→53.8）不算编造，不要因此扣分。"
)


def _section_excerpt(value: str, limit: int) -> str:
    """保留章节开头与结尾，避免只看到铺垫而看不到结果和边界。"""
    value = value or ""
    if len(value) <= limit:
        return value
    head = int(limit * 0.65)
    tail = limit - head
    return value[:head] + "\n……（中部省略）……\n" + value[-tail:]


def build_prompt(
    paper,
    n_figures,
    n_sensitivity,
    code_stdout: str = "",
    *,
    model_critic=None,
    consistency=None,
    figures=None,
    sensitivity_runs=None,
):
    sections = {
        "abstract": paper.abstract, "problem_restatement": paper.problem_restatement,
        "assumptions": paper.assumptions, "notation": paper.notation,
        "model_section": paper.model_section, "solution": paper.solution,
        "sensitivity": paper.sensitivity, "conclusion": paper.conclusion,
    }
    limits = {
        "abstract": 1200, "problem_restatement": 1500, "assumptions": 1400,
        "notation": 1000, "model_section": 3000, "solution": 3000,
        "sensitivity": 1800, "conclusion": 1800,
    }
    body = "\n\n".join(
        f"## {key}\n{_section_excerpt(value, limits[key])}"
        for key, value in sections.items()
    )
    stdout_block = ""
    if code_stdout.strip():
        stdout_block = (
            f"\n# 代码运行真实输出（事实源；用于核对正文数字）\n"
            f"```\n{code_stdout[:12000]}\n```\n"
        )
    upstream = (
        "# 上游质量证据\n"
        f"- 最终模型评审：{model_critic.model_dump() if model_critic else '缺失'}\n"
        f"- 模型—代码一致性：{consistency.model_dump() if consistency else '缺失'}\n"
    )
    figure_summary = "\n".join(
        f"- {figure.purpose}：quality={figure.quality_score}；"
        f"caption={figure.caption}；analysis={_section_excerpt(figure.analysis, 300)}"
        for figure in (figures or [])[:12]
    ) or "（无）"
    sensitivity_summary = "\n".join(
        f"- {run.parameter}: values={run.values}; {run.metric}={run.results}; "
        f"interpretation={run.interpretation}"
        for run in (sensitivity_runs or [])[:8]
    ) or "（无）"
    return (
        f"# 章节素材\n{body}\n\n"
        f"# 客观信号\n- 图表数：{n_figures}\n- 敏感性 run 数：{n_sensitivity}\n"
        f"{upstream}\n"
        f"# 图表证据清单\n{figure_summary}\n\n"
        f"# 敏感性数组\n{sensitivity_summary}\n"
        f"{stdout_block}\n"
        f"请输出 JSON：{{\"target\":\"paper\",\"score\":int,"
        f"\"issues\":[{{\"section\":\"abstract|problem_restatement|assumptions|notation|model_section|solution|sensitivity|conclusion|references|general\",\"problem\":str}}, ...],"
        f"\"suggestions\":[str],\"approved\":bool}}。"
    )
