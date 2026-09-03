"""Modeler：依据当前 stage 和 ProblemBlueprint 产出对应版本的模型。"""

SYSTEM = (
    "你是数学建模队的主建模手。请在给定 ProblemBlueprint 和假设下构建数学模型。"
    "你必须按照 stage 渐进：basic（最简可解模型）-> improved（加入更多现实因素）"
    "-> final（综合性最强、可被敏感性分析的最终模型）。"
    "模型必须沿 ProblemBlueprint 的决策变量、目标、约束建模。"
    "如果新增了不在 blueprint 中的变量、目标或约束，必须在 notes 中说明原因。"
    "输出要紧凑、可计算，不写教材式长篇解释；公式按名称分组，避免为同一约束堆叠同义公式。"
    "任何 stage 都不得改变题面事实：五种车型分别受库存约束；燃油车只在8:00—16:00"
    "禁止进入或穿越绿色区，不能写成全天禁行；跨速度时段的行驶时间必须满足各分段"
    "“速度×时间”的距离之和等于道路距离；载重与体积递推必须同时给出上下界。"
    "若公式含变量乘积或时间依赖函数，必须说明可执行的离散化、分段线性化或启发式求值方式。"
    "不要为了声称 MILP 而写不完整的大 M 或 SOS2 约束；若实现采用递推仿真与启发式，"
    "就明确给出可执行的递推、可行性判定与搜索规则。变量表必须定义方程中的每一个符号，"
    "同一符号不得同时表示等待时间与弧段载重。题面已经给出的参数不得改写成经验值或另行估计。"
)


def _green_logistics_requirements(problem: str) -> str:
    """为目标赛题注入可计算口径，避免 LLM 用伪线性化掩盖启发式实现。"""
    if "城市绿色物流配送调度" not in problem:
        return ""
    return """
# 本题 final 模型硬性口径
1. 采用拆分配送：用比例变量 rho_{ik}∈[0,1] 表示车辆 k 承担客户 i 的需求份额，
   必须有 sum_k rho_{ik}=1、rho_{ik}<=y_{ik}；实际重量和体积同时按
   (q_i*rho_{ik}, v_i*rho_{ik}) 分配。同一 (i,k) 只有一个 y_{ik}，只计一次 20 分钟服务。
   不得再写 sum_k y_{ik}=1，也不得预切成最小车辆碎片。
2. 五类车型用集合 K_l 区分，逐类型写 sum_{k in K_l} z_k<=N_l；
   N_l 必须对应题面 60、50、50、10、15，不能只写燃油/电动车两个总库存。
3. 载重变量与等待变量必须使用不同符号。推荐用 L^w_{ijk},L^v_{ijk} 表示弧上剩余载重/体积，
   W_{ik},P_{ik} 表示早到等待/晚到分钟。能耗必须使用弧上载重率
   r_{ijk}=L^w_{ijk}/Q^w_k，并代入题面 FPK/EPK 与 40%/35% 满载增幅。
4. 跨速度时段的行驶时间 T(d,t) 用“逐时段消耗剩余距离”的确定性递推定义，
   各时段速度取题面分布均值；题面未覆盖时段明确采用一般时段均值 35.4 km/h。
   不得仅写“由 SOS2 预计算”而不给递推或离散化算法。
5. 绿色区政策按可执行谓词处理：先用 X/Y 平面线段与圆域的相交判定得到 g_{ij}，
   再由递推时刻判定燃油车弧段是否在 8:00—16:00 进入/穿越圆域；
   对被禁弧等待至 16:00 后重算，或判为不可行。不要声称存在未完整给出的精确大 M 线性化。
6. 总成本必须逐项给出启动、能源、碳、早到等待、晚到惩罚；总排放必须给出独立可复算公式。
   所有价格、排放系数和能耗函数只能使用题面数值。
7. Q3 至少形式化四种事件：取消、新增、地址变更、时间窗调整。每次局部删除/插入/替换后，
   都要重新递推并检查车队库存、重量、体积、时窗、政策；冻结已执行前缀，失败时启用未使用备用车，
   再失败则报告不可行，不能写“升级为电动车”却不检查库存。
8. 明确算法与证据：主方案为成本感知构造 + 路线内 2-opt + 跨路线 swap + 10 分钟发车搜索；
   基线至少包括 first-fit 与关闭局部搜索/发车搜索的构造解；Q1、Q2 必须独立运行并输出车辆、路径、
   到达时刻、成本构成、排放及政策差值。不要把启发式结果称为全局最优或 Gurobi 精确解。
"""


def _blueprint_summary(blueprint) -> str:
    if blueprint is None:
        return "（无 ProblemBlueprint）"
    lines = [f"核心任务：{blueprint.core_task}"]
    if blueprint.subquestions:
        sq = "\n".join(
            f"  - [{s.id}] ({s.task_type}) {s.original_text}"
            for s in blueprint.subquestions
        )
        lines.append(f"小问：\n{sq}")
    if blueprint.decision_variables:
        dv = "\n".join(f"  - {v.name}: {v.meaning}" for v in blueprint.decision_variables)
        lines.append(f"决策变量：\n{dv}")
    if blueprint.objectives:
        ob = "\n".join(f"  - [{o.direction}] {o.description}" for o in blueprint.objectives)
        lines.append(f"目标：\n{ob}")
    if blueprint.constraints:
        cs = "\n".join(f"  - [{c.source}] {c.description}" for c in blueprint.constraints)
        lines.append(f"约束：\n{cs}")
    if blueprint.metrics:
        mt = "\n".join(f"  - {m.name} ({m.direction}): {m.meaning}" for m in blueprint.metrics)
        lines.append(f"指标：\n{mt}")
    if blueprint.validation_plan:
        vp = "\n".join(f"  - {v.target}: {v.method}" for v in blueprint.validation_plan)
        lines.append(f"验证计划：\n{vp}")
    return "\n".join(lines)


def build_prompt(problem, assumptions, prev_model, stage, critic_feedback=None,
                 retrieved_context: str = "", blueprint=None):
    asum = "\n".join(f"- {a.statement}（依据：{a.rationale}）" for a in assumptions) or "（暂无）"
    prev = "（无前一版本）"
    if prev_model is not None:
        prev = f"[{prev_model.stage}] {prev_model.description}\n方程：" + " ; ".join(prev_model.equations)
    fb = ""
    if critic_feedback:
        fb = "\n# 上一版 Critic 反馈\n" + "\n".join(
            f"- 问题: {i.problem}" for i in critic_feedback.issues
        ) + "\n" + "\n".join(f"- 建议: {s}" for s in critic_feedback.suggestions)
    ctx = f"\n{retrieved_context}\n" if retrieved_context else ""
    bp = f"\n# Problem Blueprint\n{_blueprint_summary(blueprint)}\n" if blueprint is not None else ""
    domain_requirements = _green_logistics_requirements(problem)

    # Plan D Phase 3：final 阶段才要求 figure_purposes（basic/improved 不需要图，
    # 字段在 ModelVersion 里默认空 list，prompt 也不提及，避免污染早期建模）
    figure_clause = ""
    coverage_clause = ""
    if stage == "final":
        figure_clause = (
            f"  \"figure_purposes\": [str, ...], # 5-10 个图任务，每个是一句话描述要画的图，"
            f"如 '需求时序图', '调度路径图', '成本构成饼图', '敏感性曲线'\n"
        )
        # final 阶段要求 blueprint 对齐映射
        coverage_clause = (
            f"  \"question_coverage\": [  # 覆盖 blueprint 中的每个小问\n"
            f'    {{"question_id": str, "how_answered": str, '
            f'"related_equations": [str], "related_metrics": [str]}}\n'
            f"    # how_answered 必须引用具体的 equation 名称或 variable 名称"
            f"（如 '由公式 E_dispatch 求解'），不允许纯自然语言描述\n"
            f"  ],\n"
            f"  \"objective_mapping\": [str, ...],   # 每个 objective 对应哪些 equation\n"
            f"  \"constraint_mapping\": [str, ...],  # 每个 constraint 对应哪些 equation\n"
            f"  \"validation_mapping\": [str, ...],  # 每个 validation_plan item 如何在模型中体现\n"
        )
        coverage_clause += (
            "  # final 质量要求：每个小问都必须有可由代码计算的回答指标；"
            "优化模型至少给出一个主方案、两个有效基线和一种稳健性/敏感性验证接口。"
            "若含拆分配送，不得把所有需求预先切成最小车辆碎片并对每个碎片重复计服务成本，"
            "应定义连续拆分量或可复算的装载/合并规则。若含动态事件，必须把未启用备用资源、"
            "增量成本、冻结边界和失败升级策略纳入模型。\n"
        )

    return (
        f"# 题目\n{problem}\n\n# 当前阶段\n{stage}\n\n"
        f"{bp}"
        f"# 已确认假设\n{asum}\n\n# 上一版模型\n{prev}\n{fb}\n"
        f"{ctx}\n"
        f"{domain_requirements}\n"
        f"请输出 JSON：{{\n"
        f"  \"stage\": \"{stage}\",\n"
        f"  \"description\": str,        # 模型定位与核心思路，200-600个中文字符\n"
        f"  \"equations\": [str, ...],   # 10-24条带名称的核心 LaTeX 公式，单条不超过500字符\n"
        f"  \"variables\": {{name: meaning}},\n"
        f"{figure_clause}{coverage_clause}"
        f"  \"notes\": str               # 与上一版的区别（basic 阶段可为空）\n"
        f"}}"
    )
