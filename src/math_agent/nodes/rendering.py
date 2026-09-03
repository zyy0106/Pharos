"""共享渲染工具函数。

latex_node 和 writer.render_markdown 共用：代码/stdout 截取、路径转义、
图注截断、纯文本转义。独立于 markdown→LaTeX 转换链（latex_transform.py），
打破 latex↔writer 的双向导入。
"""
from __future__ import annotations

import re


# ---- 纯文本转义 ----

_PLAIN_TEXT_ESCAPES = {
    "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}",
    "%": r"\%", "#": r"\#", "&": r"\&", "$": r"\$",
    "_": r"\_", "^": r"\^{}", "~": r"\~{}",
}

_ESCAPED_LAYOUT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\\r\\n"), "\n"),
    (re.compile(r"\\n\\n"), "\n\n"),
    (re.compile(r"\\n(?=(?:\\|[ \t]*[-*#]|\d+\.)|$)"), "\n"),
    (re.compile(r"\\t(?=(?:\\|[ \t]*[-*#]|\d+\.)|$)"), "\t"),
]


def _latex_plain_text(s: str | None) -> str | None:
    """完整转义封面元数据等不允许包含 LaTeX 数学的纯文本。"""
    if s is None:
        return None
    return "".join(_PLAIN_TEXT_ESCAPES.get(ch, ch) for ch in s)


def _normalize_escaped_layout_text(s: str | None) -> str | None:
    """把误写成字面量的 \\n / \\t 恢复为排版空白，避免污染 markdown/latex 渲染。"""
    if s is None or "\\" not in s:
        return s
    out = s
    prev = None
    while out != prev:
        prev = out
        for pattern, repl in _ESCAPED_LAYOUT_PATTERNS:
            out = pattern.sub(repl, out)
    return out


# ---- 路径转义 ----

def _latex_path(p: str) -> str:
    """把 Windows 路径包成 LaTeX 可读形式：正斜杠 + \\detokenize 阻止解释 _ 等。"""
    # 右花括号会结束 \detokenize 参数，需关闭参数、输出字符 125 后再开启。
    safe = p.replace("\\", "/").replace("}", r"}\char125\detokenize{")
    return r"\detokenize{" + safe + "}"


# ---- 图注截断 ----

def _truncate_caption(s: str, *, max_chars: int = 55) -> str:
    """把长图注截到 max_chars 以内，但优先切在完整句/短语边界。

    LLM 写的图 caption 常常两三个句子；直接 `s[:55]` 会切在逗号/单字上。
    策略：先看 max_chars 处是否已是终结符；否则在整个可保留前缀中找最靠后的
    句末字符；没有才退到后 40% 区间内最靠后的逗号；再退不到就硬截。

    句末搜索不能只看后 40%：真实图注的第一句常很短，第二句包含小数，旧逻辑会
    忽略前一句句号并把 ``44.0%`` 或 ``0.97`` 截成 ``44.`` / ``0.``。
    """
    if not s or len(s) <= max_chars:
        return s
    hard_end = s[max_chars - 1]
    hard_dot_is_decimal = (
        hard_end == "."
        and max_chars >= 2
        and max_chars < len(s)
        and s[max_chars - 2].isdigit()
        and s[max_chars].isdigit()
    )
    if hard_end in "。！？；!?" or (hard_end == "." and not hard_dot_is_decimal):
        return s[:max_chars]
    prefix = s[:max_chars]
    sentence_ends = [
        match.end() - 1
        for match in re.finditer(r"[。！？；!?]|(?<!\d)\.|\.(?!\d)", prefix)
    ]
    sentence_idx = max(sentence_ends, default=-1)
    if sentence_idx >= 4:
        return s[: sentence_idx + 1]
    lo = max(1, int(max_chars * 0.6))
    phrase = s[lo:max_chars]
    phrase_idx = max((phrase.rfind(c) for c in "，、,"), default=-1)
    if phrase_idx != -1:
        candidate = s[: lo + phrase_idx].rstrip()
        return candidate + ("。" if any("\u4e00" <= ch <= "\u9fff" for ch in candidate) else ".")
    return s[:max_chars]


# ---- 代码/stdout 截取 ----

def _curate_code(code: str, max_lines: int = 80) -> str:
    """截取代码前 max_lines 行。"""
    lines = [
        line for line in code.split("\n")
        if "BEACON_GREEN_LOGISTICS_SAFE_SOLVER" not in line
    ]
    lines = [
        re.sub(r"^\s*DATA_DIR\s*=\s*Path\(.+\)\s*$", 'DATA_DIR = Path("./data")', line)
        for line in lines
    ]
    if len(lines) <= max_lines:
        return "\n".join(lines)
    return "\n".join(lines[:max_lines]) + f"\n# ... (共 {len(lines)} 行，截取前 {max_lines} 行)"


def _curate_stdout(stdout: str) -> str:
    """提取关键计算结果，并转换为适合论文附录阅读的中文摘要。"""
    if not stdout:
        return ""
    lines = stdout.splitlines()
    result_lines = [l for l in lines if l.strip().startswith("RESULT:")]
    tail = lines[-5:]
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for l in result_lines + tail:
        if l not in seen:
            seen.add(l)
            out.append(l)
    return "\n".join(_publication_result_line(line) for line in out)


_RESULT_LABELS = {
    "RESULT": "方案结果", "BREAKDOWN": "成本分解", "DATA_PROFILE": "数据概况",
    "DYNAMIC_STRESS": "动态压力测试", "ALGORITHM_SEARCH": "局部搜索",
    "ROBUSTNESS": "随机交通稳健性", "SERVICE_DIAGNOSTICS": "服务诊断",
    "DYNAMIC_EVENTS": "动态事件实验",
}

_RESULT_KEYS = {
    "baseline": "方案", "ours": "本文方案", "no_schedule": "无调度方案",
    "simple_pred": "定速预测方案", "greedy": "贪婪构造方案",
    "total_cost": "总成本", "vehicles": "车辆数", "service_rate": "服务率",
    "total_carbon": "碳排放", "total_distance": "总里程", "fuel_vehicles": "燃油车数",
    "ev_vehicles": "新能源车数", "avg_delivery_time": "平均配送时间",
    "timewin_rate": "时间窗满足率", "fuel_ratio": "燃油车比例",
    "response_time": "响应时间", "dynamic_reinserted": "局部重插成功标志",
    "dynamic_distance_change": "重插距离变化", "dynamic_distance_improved": "距离改善标志",
    "samples": "样本数", "success": "成功数", "success_rate": "成功率",
    "mean_response_ms": "平均响应时间（毫秒）", "p95_response_ms": "P95响应时间（毫秒）",
    "mean_distance_change": "平均距离变化", "max_distance_change": "最大距离变化",
    "improved": "改善样本数", "mean_late_change": "平均晚到变化",
    "initial_score": "初始目标", "final_score": "改进后目标", "improvement": "改善量",
    "improvement_rate": "改善率", "moves": "有效移动数", "passes": "搜索轮数",
    "runtime_ms": "计算耗时（毫秒）", "scenarios": "情景数", "seed": "随机种子",
    "timewin_mean": "时间窗率均值", "timewin_std": "时间窗率标准差",
    "timewin_p05": "时间窗率5%分位", "late_mean": "平均晚到量",
    "late_p95": "晚到量P95", "cost_mean": "成本均值", "cost_p95": "成本P95",
    "late_tasks": "晚到任务数", "mean_late_min": "平均晚到（分钟）",
    "p95_late_min": "P95晚到（分钟）", "max_late_min": "最大晚到（分钟）",
    "mean_weight_util": "平均载重利用率", "mean_volume_util": "平均容积利用率",
    "empty_return_ratio": "空载返程比例", "cancellation_success_rate": "订单取消成功率",
    "new_order_success_rate": "新增订单成功率", "address_change_success_rate": "地址变更成功率",
    "time_window_success_rate": "时间窗变更成功率",
    "vehicle_failure_success_rate": "车辆故障恢复成功率", "fallback_rate": "升级处理比例",
}


def _publication_result_line(line: str) -> str:
    match = re.match(r"\s*([A-Z][A-Z_]*):\s*(.*)$", line)
    if match is None:
        return line
    label, payload = match.groups()
    title = _RESULT_LABELS.get(label, label.replace("_", " ").title())
    parts: list[str] = []
    for token in payload.split():
        if "=" not in token:
            parts.append(token)
            continue
        key, value = token.split("=", 1)
        display_key = _RESULT_KEYS.get(key, key.replace("_", " "))
        display_value = _RESULT_KEYS.get(value, value)
        parts.append(f"{display_key}={display_value}")
    return f"{title}：" + "；".join(parts)
