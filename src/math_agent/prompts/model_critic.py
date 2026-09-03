"""ModelCritic：从假设合理性、数学严密性、与题目相关性、可计算性 4 维度评分，
并检查模型与 ProblemBlueprint 的对齐情况。"""

SYSTEM = (
    "你是国赛评委。请就给定模型给出 0-10 的整数总评分（>=7 视为通过），"
    "并列出至多 5 个 issues 与至多 5 个 suggestions。"
    "approved 判定规则：只有存在【严重问题】时才 approved=False。"
    "严重问题 = 假设与模型矛盾、方程量纲不一致、模型不可计算、完全偏题、"
    "模型未覆盖 blueprint 中的小问、模型变量/目标/约束与 blueprint 明显不一致。"
    "改进建议（如『可用更优模型』『假设可放宽』）不影响 approved，只写进 suggestions。"
    "重点检查：假设是否被显式承接、方程量纲是否一致、是否存在更优经典模型。"
    "Blueprint 对齐检查：是否覆盖所有小问、变量是否对应 blueprint、"
    "目标函数是否对应 blueprint、约束是否对应 blueprint、"
    "final model 是否包含 baseline、validation plan 是否可执行。"
    "交叉验证 question_coverage：如果模型声称覆盖了某小问，但 equations 中找不到对应的公式，记为 issue。"
    "若模型明确采用启发式与递推仿真，可执行的递推/谓词/伪代码就是合法数学模型；"
    "不要强迫其伪装成 MILP。反之，声称精确 MILP、全局最优或商业求解器时，必须有完整公式和实际证据。"
    "题面允许拆分时，sum_k rho_ik=1 与同车同客户一次到访是正确口径，不能误判为必须 sum_k y_ik=1。"
    "评审必须尊重渐进阶段：basic 只需形成问题1的最简可解模型，不得因尚未覆盖问题2/3扣为严重问题；"
    "improved 应覆盖问题1/2并增强现实约束；只有 final 必须覆盖全部小问、baseline 与验证计划。"
    "弧段载重率若按每条弧出发时的剩余载重定义，并在服务后递减，就是实时载重，不得误判为忽略载重变化。"
    "题面给出速度分布时，用均值构造主情景、再用速度缩放敏感性或蒙特卡洛验证是合法竞赛建模路线，"
    "不能仅因未在主模型中写机会约束就判为严重问题。"
)


def _blueprint_context(blueprint) -> str:
    if blueprint is None:
        return ""
    lines = []
    if blueprint.subquestions:
        sq = "\n".join(f"  - [{s.id}] ({s.task_type}) {s.original_text}" for s in blueprint.subquestions)
        lines.append(f"## Blueprint 小问\n{sq}")
    if blueprint.decision_variables:
        dv = "\n".join(f"  - {v.name}: {v.meaning}" for v in blueprint.decision_variables)
        lines.append(f"## Blueprint 决策变量\n{dv}")
    if blueprint.objectives:
        ob = "\n".join(f"  - [{o.direction}] {o.description}" for o in blueprint.objectives)
        lines.append(f"## Blueprint 目标\n{ob}")
    if blueprint.constraints:
        cs = "\n".join(f"  - {c.description}" for c in blueprint.constraints)
        lines.append(f"## Blueprint 约束\n{cs}")
    if blueprint.validation_plan:
        vp = "\n".join(f"  - {v.target}: {v.method}" for v in blueprint.validation_plan)
        lines.append(f"## Blueprint 验证计划\n{vp}")
    return "\n".join(lines)


def _coverage_context(model) -> str:
    if not model.question_coverage:
        return ""
    lines = ["## 模型声称的 question_coverage"]
    for cov in model.question_coverage:
        lines.append(f"  - [{cov.question_id}] {cov.how_answered}")
        if cov.related_equations:
            lines.append(f"    related_equations: {cov.related_equations}")
    return "\n".join(lines)


def build_prompt(problem, assumptions, model, blueprint=None):
    asum = "\n".join(f"- {a.statement}" for a in assumptions)
    eqs = "\n".join(f"  - $$ {e} $$" for e in model.equations)
    vars_ = "\n".join(f"  - {k}: {v}" for k, v in model.variables.items())
    bp = ""
    if blueprint is not None:
        bp = f"\n\n{_blueprint_context(blueprint)}"
    cov = ""
    if model.stage == "final":
        cov = f"\n\n{_coverage_context(model)}"
        bp += "\n\n## 对齐检查要求\nfinal 模型必须包含 baseline，validation plan 必须可执行。"
    elif model.stage == "basic":
        bp += "\n\n## 阶段检查要求\nbasic 是问题1的最简可解模型，不要求提前覆盖问题2/3。"
    elif model.stage == "improved":
        bp += "\n\n## 阶段检查要求\nimproved 应覆盖问题1/2；问题3可留到 final。"
    derivation_audit = ""
    if model.derivation_notes:
        derivation_audit = f"\n\n## 推导一致性检查发现的问题\n{model.derivation_notes}"
    return (
        f"# 题目\n{problem}\n\n# 假设\n{asum}\n\n# 模型（{model.stage}）\n"
        f"{model.description}\n方程：\n{eqs}\n变量：\n{vars_}{bp}{cov}{derivation_audit}\n\n"
        f"请输出 JSON：{{\"target\":\"modeler\",\"score\":int,\"issues\":[{{\"section\":\"general\",\"problem\":str}}, ...],\"suggestions\":[str],\"approved\":bool}}"
    )
