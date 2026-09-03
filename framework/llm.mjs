function extractJson(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || source;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象。");
  try { return JSON.parse(fenced.slice(start, end + 1)); }
  catch (error) { throw new Error(`模型返回的 JSON 无法解析：${error.message}`); }
}

async function chat(config, messages, { temperature = 0.1, maxTokens = 5000 } = {}) {
  if (!config.apiKey || !config.model) throw new Error("真实模式缺少 API Key 或模型名。");
  const endpoint = `${String(config.apiBase).replace(/\/$/, "")}/chat/completions`;
  const requestBody = JSON.stringify({ model: config.model, messages, temperature, max_tokens: maxTokens });
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: requestBody,
        signal: AbortSignal.timeout(120000),
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
      if (!response.ok) {
        const detail = body.error?.message || body.message || body.raw?.replace(/\s+/g, " ").slice(0, 500) || "未知错误";
        lastError = new Error(`模型调用失败 ${response.status}（第 ${attempt}/3 次）：${detail}`);
        if (!retryableStatuses.has(response.status) || attempt === 3) throw lastError;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 800 * attempt));
        continue;
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error(`模型返回为空（第 ${attempt}/3 次）。`);
      return { content, usage: body.usage || null, model: body.model || config.model };
    } catch (error) {
      lastError = error;
      const retryableNetworkError = error?.name === "TimeoutError" || error?.name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|模型调用失败 (?:408|425|429|500|502|503|504|520|522|524)/i.test(error?.message || "");
      if (!retryableNetworkError || attempt === 3) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800 * attempt));
    }
  }
  throw lastError || new Error("模型调用失败：未知错误");
}

function array(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (value == null || value === "") return [];
  return [String(value)];
}

function validatePath(path) {
  const value = String(path || "").replaceAll("\\", "/").trim();
  const parts = value.split("/");
  if (!value || value.startsWith("/") || parts.includes("..") || parts.includes(".") || /^(manifest|supervisor_verdict)\.json$/i.test(value)) {
    throw new Error(`模型返回了不允许的文件路径：${path}`);
  }
  return value;
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("模型没有返回 files 文件清单。");
  const seen = new Set();
  const result = files.map((file) => {
    if (!file || typeof file !== "object") throw new Error("模型 files 中包含无效文件对象。");
    const path = validatePath(file.path);
    if (seen.has(path)) throw new Error(`模型重复返回文件：${path}`);
    seen.add(path);
    const content = typeof file.content === "string" ? file.content : "";
    if (!content && path === "result_code.py") throw new Error("模型返回的 result_code.py 为空。");
    if (Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024) throw new Error(`模型文件过大：${path}`);
    return { path, content, purpose: String(file.purpose || "") };
  });
  if (!seen.has("result_code.py")) throw new Error("模型必须返回可执行的 result_code.py；不能使用框架模板替代。");
  return result;
}

function validateReasoning(reasoning) {
  if (!reasoning || typeof reasoning !== "object") throw new Error("模型没有返回结构化 reasoning。");
  const result = {
    observations: array(reasoning.observations), hypotheses: array(reasoning.hypotheses), alternatives: array(reasoning.alternatives),
    decision: String(reasoning.decision || ""), decision_basis: array(reasoning.decision_basis), tool_plan: array(reasoning.tool_plan),
    checks: array(reasoning.checks), result: String(reasoning.result || ""), uncertainty: array(reasoning.uncertainty), next_action: String(reasoning.next_action || ""),
  };
  if (!result.observations.length || !result.alternatives.length || !result.decision || !result.decision_basis.length || !result.tool_plan.length || !result.checks.length || !result.next_action) {
    throw new Error("模型 reasoning 缺少观察、替代方案、决策依据、工具计划、检查点或下一步。");
  }
  return result;
}

function validatePackage(value) {
  if (!value || typeof value !== "object") throw new Error("模型返回的 Agent 包不是对象。");
  const documentMarkdown = String(value.document_markdown || "").trim();
  const issuesMarkdown = String(value.issues_markdown || "").trim();
  const improvementMarkdown = String(value.improvement_markdown || "").trim();
  if (!documentMarkdown || !issuesMarkdown || !improvementMarkdown) throw new Error("模型必须同时返回三份交接 Markdown 文档。");
  return { files: validateFiles(value.files), document_markdown: documentMarkdown, issues_markdown: issuesMarkdown, improvement_markdown: improvementMarkdown, reasoning: validateReasoning(value.reasoning) };
}

function validateReflection(value) {
  if (!value || typeof value !== "object") throw new Error("模型返回的反思不是对象。");
  const documentMarkdown = String(value.document_markdown || "").trim();
  const issuesMarkdown = String(value.issues_markdown || "").trim();
  const improvementMarkdown = String(value.improvement_markdown || "").trim();
  if (!documentMarkdown || !issuesMarkdown || !improvementMarkdown) throw new Error("反思阶段必须返回三份交接 Markdown 文档。");
  return { document_markdown: documentMarkdown, issues_markdown: issuesMarkdown, improvement_markdown: improvementMarkdown, reasoning: validateReasoning(value.reasoning) };
}

function agentSystem(context, phase) {
  return `你是数学建模竞赛工作台中的 ${context.stage.role}（${context.stage.agent}），当前节点是“${context.stage.label}”。这是第 ${phase} 阶段：${phase === "repair" ? "根据工具失败反馈修复方案和文件" : phase === "reflection" ? "根据真实执行证据完成反思和交接定稿" : "独立分析问题并提出可执行方案"}。

你必须进行问题驱动的分析，而不是套用固定模板：先从 workspace_snapshot 和已批准历史中提取事实，再提出至少一个替代方案，比较目标、假设、复杂度、风险和验证方式，最后做出有依据的选择。工作台实际执行的工具包括读取已批准文件、写入当前 staging 文件、运行 Python、查看 stdout/stderr、核对文件哈希。input_integrity.json 是框架生成的权威输入完整性记录；代码必须读取或引用它，不能凭模型记忆、手工抄写或修改输入文件哈希，也不能把 result_code.py 中的哈希常量当成权威来源。不得声称没有执行的工具已经执行。

安全边界：只能为当前 staging 交接包产出文件；不能批准自己、不能写入 approved、不能跳过 Agent Supervisor 或唯一人类的两次审核；不能伪造数字；不得输出隐式思维链，只输出可审计的事实、决策依据、工具计划、检查结果和不确定性。

严格只返回 JSON，不要 Markdown 代码围栏，字段必须是：files（每项含 path、content、purpose，必须有 result_code.py）、document_markdown、issues_markdown、improvement_markdown、reasoning。reasoning 必须含 observations、hypotheses、alternatives、decision、decision_basis、tool_plan、checks、result、uncertainty、next_action。所有数字必须来自输入或执行证据，无法确认就明确写入 issues。`;
}

function userContext(context) {
  return JSON.stringify({
    node: { key: context.stage.key, label: context.stage.label, role: context.stage.role, agent: context.stage.agent, brief: context.stage.brief },
    problem: context.problem, constitution: context.constitution, approved_history: context.history,
    revision_requests: context.revision_requests || [], workspace_snapshot: context.workspace_snapshot || [], execution: context.execution || null,
    generated_files: context.generated_files || [],
    tool_contract: { runtime: "result_code.py 在项目根目录执行；通过 FRAMEWORK_INPUT_DIR 读取已确认输入，通过 FRAMEWORK_OUTPUT_DIR 写入实验输出。", integrity: "input_integrity.json 由框架生成并记录每个输入文件的实际 SHA-256；路径由 FRAMEWORK_INPUT_INTEGRITY_PATH 提供；不得由 Agent 改写。", evidence: "stdout.txt、stderr.txt、execution_log.json 是真实工具证据；失败不得被文档语言掩盖。", handoff: "当前包必须经过独立 Supervisor、唯一人类第一审、唯一人类第二审，才可原子晋级。" },
  });
}

async function generatePhase(config, context, phase, options = {}) {
  const result = await chat(config, [{ role: "system", content: agentSystem(context, phase) }, { role: "user", content: userContext(context) }], { temperature: options.temperature ?? 0.2, maxTokens: options.maxTokens ?? 6500 });
  return { ...validatePackage(extractJson(result.content)), llm: { model: result.model, usage: result.usage }, phase };
}

export async function generateAgentPackage(config, context) { return generatePhase(config, context, "planning", { temperature: Math.max(0.1, Number(config.temperature ?? 0.2)), maxTokens: 6500 }); }
export async function repairAgentPackage(config, context) { return generatePhase(config, context, "repair", { temperature: 0.1, maxTokens: 6500 }); }
export async function reflectAgentPackage(config, context) {
  const system = `你是数学建模竞赛工作台中的 ${context.stage.role}（${context.stage.agent}），当前节点是“${context.stage.label}”的反思审计阶段。

请根据 workspace_snapshot、已批准历史、当前 Agent 生成文件和真实 execution 证据，更新交接文档与结构化判断。反思阶段只能修改三份 Markdown 文档和 reasoning，不能返回 files 字段，不能修改或替换任何已经执行过的代码、数据、HTML、Excel、图片或其他产物。若发现代码或其他文件需要修改，必须在 reasoning.next_action 中明确要求重新进入 repair 阶段，不能在本阶段直接改动。

不要输出隐式思维链，只输出可审计事实、替代方案、决策依据、工具计划、检查结果、不确定性和下一步。严格返回 JSON，字段必须是 document_markdown、issues_markdown、improvement_markdown、reasoning；reasoning 必须包含 observations、hypotheses、alternatives、decision、decision_basis、tool_plan、checks、result、uncertainty、next_action。`;
  const result = await chat(config, [{ role: "system", content: system }, { role: "user", content: userContext(context) }], { temperature: 0.1, maxTokens: 5000 });
  return { ...validateReflection(extractJson(result.content)), llm: { model: result.model, usage: result.usage }, phase: "reflection" };
}

function validateVerdict(value, model) {
  if (!value || !["submit_for_human_review", "revise"].includes(value.decision)) throw new Error("Supervisor 返回了无效 decision。");
  return { decision: value.decision, constitutional_status: String(value.constitutional_status || "fail"), technical_status: String(value.technical_status || "infeasible"), evidence_status: String(value.evidence_status || "incomplete"), reproducibility_status: String(value.reproducibility_status || "unknown"), blocking_issues: array(value.blocking_issues), required_repairs: array(value.required_repairs), supervisor_basis: array(value.supervisor_basis || value.reasoning), supervisor_version: `llm-supervisor:${model}`, usage: value.usage || null };
}

export async function supervisePackage(config, context) {
  const system = "你是独立 Agent Supervisor，不是当前 Agent，必须对当前 staging 文件包做反向审查。只根据 manifest、文件摘要、执行日志、宪法和历史证据判断；检查文件是否真实存在、代码是否执行、结论能否追溯、是否违反宪法、是否具备复现条件。不要因为未来节点尚未生成而阻断当前节点，也不能替 Agent 补写文件。decision 只能是 submit_for_human_review 或 revise。若 execution 失败、Agent 生成失败、文件缺失或证据不足，必须 revise。严格返回 JSON：decision、constitutional_status、technical_status、evidence_status、reproducibility_status、blocking_issues、required_repairs、supervisor_basis。不要输出隐式思维链。";
  const result = await chat(config, [{ role: "system", content: system }, { role: "user", content: JSON.stringify(context) }], { temperature: 0, maxTokens: 1800 });
  return validateVerdict(extractJson(result.content), result.model);
}

export { extractJson, validatePackage };
