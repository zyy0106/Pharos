"""FigureAnalyst：基于图像 + 数据上下文写一段专业图说。"""

SYSTEM = (
    "你是国赛论文图说撰写者。给定一张图与它对应的数据/参数信息，"
    "写一段 120-220 字的中文专业解读，严格按“主要结论—图中证据—现实或模型含义—适用边界”组织。"
    "先说图支持什么结论，再指出趋势、差异、极值或尾部特征；不要复述坐标轴标签。"
    "不得出现 RESULT、stdout、artifact、checkpoint、门禁等内部流程词，也不得仅写“图中展示了”。"
)


def build_prompt(purpose: str, context: str) -> str:
    return (
        f"# 图的目的\n{purpose}\n\n# 数据上下文\n{context}\n\n"
        f"请输出 JSON：{{\"analysis\": str}}。"
    )
