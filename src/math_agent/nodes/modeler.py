import logging

from math_agent.llm import complete
from math_agent.config import (
    MODEL_ROUTING, RAG_ENABLED, RAG_DB_PATH, RAG_EMBEDDING_MODEL,
    RAG_EMBEDDING_DIM, RAG_TOPK, RAG_CTX_MAX_CHARS_MODELER,
)
from math_agent.prompts.modeler import SYSTEM, build_prompt
from math_agent.prompts.modeler_derivation import (
    DERIVATION_STEPS, build_derivation_prompt, build_consistency_prompt,
    ConsistencyCheck,
)
from math_agent.rag.retrieve import search, format_snippets
from math_agent.state import MathModelingState, ModelVersion, DerivationStep

logger = logging.getLogger(__name__)

_STAGE_MAX_TOKENS = {
    "basic": 2600,
    "improved": 3800,
    # 目标赛题的 final JSON 含 20+ 方程、三问映射和图表任务；5000 token
    # 已在真实运行中截断于字符串中部。6000 仍显著低于早期 6400 的超时风险，
    # 同时给结构化 JSON 留出完整闭合空间。
    "final": 6000,
}


def _build_model_draft(state: MathModelingState) -> ModelVersion | None:
    """只生成模型草稿，供生产图中的单调用节点使用。"""
    if state.problem_blueprint is None:
        return None
    same_stage_prev = next(
        (m for m in reversed(state.model_versions) if m.stage == state.stage_target), None,
    )
    prev_for_stage = same_stage_prev or (state.model_versions[-1] if state.model_versions else None)
    critic_fb = state.latest_critic_for_stage("modeler", state.stage_target)
    if critic_fb and critic_fb.approved:
        critic_fb = None
    ctx = ""
    if RAG_ENABLED:
        query = (state.problem + " " + state.stage_target + " "
                 + (prev_for_stage.description if prev_for_stage else "")).strip()
        snippets = search(query, db_path=RAG_DB_PATH, k=RAG_TOPK,
                          embedding_model=RAG_EMBEDDING_MODEL, dim=RAG_EMBEDDING_DIM)
        ctx = format_snippets(snippets, max_chars=RAG_CTX_MAX_CHARS_MODELER)
    out: ModelVersion = complete(
        build_prompt(state.problem, state.assumptions, prev_for_stage, state.stage_target,
                     critic_fb, retrieved_context=ctx, blueprint=state.problem_blueprint),
        schema=ModelVersion, system=SYSTEM, model=MODEL_ROUTING["modeler"], profile="long",
        max_tokens=_STAGE_MAX_TOKENS[state.stage_target],
    )
    out.stage = state.stage_target
    return out


def modeler_prepare_node(state: MathModelingState) -> dict:
    """生成草稿；final 阶段初始化逐步推导队列。"""
    out = _build_model_draft(state)
    if out is None:
        return {"errors": ["modeler: missing problem_blueprint"], "modeler_phase": "done"}

    # basic / improved 不运行昂贵的逐步推导；final 的每一轮（包括末轮）都必须完成
    # 推导与一致性检查。质量不能在预算将尽时反而降低。
    if out.stage != "final":
        return {
            "model_versions": [out], "iteration": state.iteration + 1,
            "modeler_phase": "done", "modeler_draft": None,
            "modeler_derivation_queue": [], "modeler_completed_derivations": [],
        }

    return {
        "modeler_draft": out, "modeler_phase": "derive",
        "modeler_derivation_queue": list(DERIVATION_STEPS),
        "modeler_completed_derivations": [],
    }


def modeler_derivation_node(state: MathModelingState) -> dict:
    """完成一个推导步骤；成功返回即产生 checkpoint。"""
    queue = list(state.modeler_derivation_queue)
    draft = state.modeler_draft
    if draft is None or not queue:
        return {"modeler_phase": "check" if draft is not None else "done"}
    step_kind = queue.pop(0)
    step: DerivationStep = complete(
        build_derivation_prompt(draft, step_kind, state.modeler_completed_derivations),
        schema=DerivationStep, system=SYSTEM, model=MODEL_ROUTING["modeler"],
    )
    return {
        "modeler_derivation_queue": queue,
        "modeler_completed_derivations": [*state.modeler_completed_derivations, step],
        "modeler_phase": "derive" if queue else "check",
    }


def modeler_consistency_node(state: MathModelingState) -> dict:
    """检查已持久化的推导链并提交最终模型。"""
    draft = state.modeler_draft
    if draft is None:
        return {"errors": ["modeler: missing final draft"], "modeler_phase": "done"}
    completed = list(state.modeler_completed_derivations)
    consistency: ConsistencyCheck = complete(
        build_consistency_prompt(draft, completed), schema=ConsistencyCheck,
        system=SYSTEM, model=MODEL_ROUTING["modeler"],
    )
    draft.derivation_steps = completed
    if not consistency.coherent:
        logger.warning("Derivation consistency check failed: %s", consistency.issues)
        draft.derivation_notes = "; ".join(consistency.issues)
    return {
        "model_versions": [draft], "iteration": state.iteration + 1,
        "modeler_phase": "done", "modeler_draft": None,
        "modeler_derivation_queue": [], "modeler_completed_derivations": [],
    }


def modeler_node(state: MathModelingState) -> dict:
    # 没有 blueprint 不进入自由建模
    if state.problem_blueprint is None:
        return {"errors": ["modeler: missing problem_blueprint"]}

    # 只关心针对当前阶段的上一版模型与上一份 critic，避免跨阶段污染。
    same_stage_prev = next(
        (m for m in reversed(state.model_versions) if m.stage == state.stage_target),
        None,
    )
    # 没有同阶段的上一版时，把上一阶段的最终版作为参考（用于 improved 起步）
    prev_for_stage = same_stage_prev or (state.model_versions[-1] if state.model_versions else None)

    critic_fb = state.latest_critic_for_stage("modeler", state.stage_target)
    if critic_fb and critic_fb.approved:
        critic_fb = None

    ctx = ""
    if RAG_ENABLED:
        prev_desc = prev_for_stage.description if prev_for_stage else ""
        query = (state.problem + " " + state.stage_target + " " + prev_desc).strip()
        snippets = search(
            query,
            db_path=RAG_DB_PATH, k=RAG_TOPK,
            embedding_model=RAG_EMBEDDING_MODEL, dim=RAG_EMBEDDING_DIM,
        )
        ctx = format_snippets(snippets, max_chars=RAG_CTX_MAX_CHARS_MODELER)

    prompt = build_prompt(
        state.problem, state.assumptions, prev_for_stage, state.stage_target,
        critic_fb, retrieved_context=ctx, blueprint=state.problem_blueprint,
    )
    out: ModelVersion = complete(
        prompt, schema=ModelVersion, system=SYSTEM,
        model=MODEL_ROUTING["modeler"], profile="long",
        max_tokens=_STAGE_MAX_TOKENS[state.stage_target],
    )
    out.stage = state.stage_target

    if out.stage == "final":
        completed: list[DerivationStep] = []
        for step_kind in DERIVATION_STEPS:
            step = complete(
                build_derivation_prompt(out, step_kind, completed),
                schema=DerivationStep,
                system=SYSTEM,
                model=MODEL_ROUTING["modeler"],
            )
            completed.append(step)
        consistency = complete(
            build_consistency_prompt(out, completed),
            schema=ConsistencyCheck,
            system=SYSTEM,
            model=MODEL_ROUTING["modeler"],
        )
        if not consistency.coherent:
            logger.warning("Derivation consistency check failed: %s", consistency.issues)
            out.derivation_notes = "; ".join(consistency.issues)
        out.derivation_steps = completed

    return {"model_versions": [out], "iteration": state.iteration + 1}
