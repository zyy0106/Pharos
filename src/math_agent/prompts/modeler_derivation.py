"""Modeler 推导链 prompt：6 步推导，每步把已完成的前序步骤喂回 LLM。

Plan D Phase 4：
- final 阶段才运行；basic / improved 不运行（derivation_steps 默认空）。
- 每步一次 LLM 调用（schema=DerivationStep），共 6 步。
- 跑完 6 步后做一次 self-consistency gate（schema=ConsistencyCheck），
  若不连贯则把问题写入 ModelVersion.derivation_notes。
"""

from pydantic import BaseModel, Field

from math_agent.state import ModelVersion, DerivationStep

# 6 步推导的固定顺序（feed-forward：每步看到前面所有步的结果）
DERIVATION_STEPS = [
    "motivation",        # 1. 动机：为什么用这个模型族
    "math_statement",    # 2. 数学陈述：模型族形式化
    "param_estimation",  # 3. 参数估计：MLE / 矩估计
    "constraints",       # 4. 约束推导：定常性 / 可解性 → 参数约束
    "transformation",    # 5. 等价变换：Markov 形式 / 状态空间
    "solution",          # 6. 求解：解析解 / 数值方法 / 滤波
]

# Human-readable labels for each step kind, shown to the LLM
_STEP_LABELS = {
    "motivation": "模型选择动机",
    "math_statement": "数学陈述",
    "param_estimation": "参数估计",
    "constraints": "约束推导",
    "transformation": "等价变换",
    "solution": "求解",
}

_STEP_GUIDANCE = {
    "motivation": "为什么选择这个模型族？与题目结构的对应关系是什么？相比朴素模型有何优势？",
    "math_statement": "给出模型族的严格数学形式化（含下标、求和、条件），用 LaTeX。",
    "param_estimation": (
        "逐项区分题面给定、由附件计算和确实需要估计的参数。题面已给参数直接引用，"
        "不得另造经验值；若无需统计估计，应明确写“无需估计”并给出数据预处理公式。"
    ),
    "constraints": (
        "推导容量、守恒、时间递推、资源库存和政策可行性条件。若采用启发式判定，"
        "给出可执行谓词或伪代码，不得用不完整的大 M/SOS2 公式冒充精确线性化。"
    ),
    "transformation": (
        "给出与实际求解器一致的计算表示，如客户需求任务化、路线序列递推、"
        "增量成本或邻域操作；只有确有必要时才引入 Markov/状态空间，不能强行套用。"
    ),
    "solution": (
        "给出与最终实现一致的算法步骤、停止条件、复杂度和可行性复检；"
        "启发式只能称为可行/改进解，不得虚称全局最优或未实际使用的商业求解器。"
    ),
}


class ConsistencyCheck(BaseModel):
    """推导链自洽性检查结果（self-consistency gate 产出）。"""
    coherent: bool
    issues: list[str] = Field(default_factory=list)


def build_derivation_prompt(model: ModelVersion, step_kind: str,
                            completed_steps: list[DerivationStep]) -> str:
    """构造单步推导 prompt。把已完成的前序步骤喂回，保证 step 间逻辑连贯。"""
    prev = "\n".join(
        f"[{i+1}] {s.title}: {s.statement} → {s.result}"
        for i, s in enumerate(completed_steps)
    ) or "（这是第一步，无前序）"
    label = _STEP_LABELS.get(step_kind, step_kind)
    guidance = _STEP_GUIDANCE.get(step_kind, "")
    return (
        f"# 模型\n{model.description}\n\n方程：{'; '.join(model.equations)}\n\n"
        f"# 已完成推导步骤\n{prev}\n\n"
        f"# 当前步骤：{label}\n{guidance}\n\n"
        f"当前步骤只能解释或推导上方模型，不能引入模型方程/变量表中不存在的新符号、"
        f"新数据或另一套求解方法；若发现模型本身缺项，应在 result 中明确指出而不是自行编造。\n\n"
        f"请输出 JSON：{{\"title\": str, \"motivation\": str, \"statement\": str, \"result\": str}}。"
        f"title 用简短中文标签，statement 含 inline LaTeX，result 给出推导结论。"
    )


def build_consistency_prompt(model: ModelVersion,
                             completed_steps: list[DerivationStep]) -> str:
    """Self-consistency gate：回看整个推导链，检查逻辑连贯性。"""
    chain = "\n".join(
        f"[{i+1}] {s.title}: {s.statement} → {s.result}"
        for i, s in enumerate(completed_steps)
    )
    return (
        f"# 模型\n{model.description}\n\n方程：{'; '.join(model.equations)}\n\n"
        f"# 完整推导链\n{chain}\n\n"
        f"请审查上述推导链的逻辑连贯性：步骤间是否有矛盾？假设是否一致？结论是否由前提推出？"
        f"是否另造题面参数、变量或求解器？是否把启发式虚称为精确最优？"
        f"所有线性化/递推/可行性谓词是否完整且与主模型一致？\n"
        f"请输出 JSON：{{\"coherent\": bool, \"issues\": [str, ...]}}。"
        f"coherent=true 表示逻辑连贯；issues 列出发现的问题（为空则 coherent=true）。"
    )
