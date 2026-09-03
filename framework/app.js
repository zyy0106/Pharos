const $ = (selector) => document.querySelector(selector);
const state = { data: null, events: [], activeFile: "result_document.md" };
const fileLabels = {
  "result_code.py": "结果代码.py",
  "result_document.md": "结果文档.md",
  "result_issues.md": "现存问题.md",
  "result_improvement_direction.md": "改进方向.md",
  "reasoning_trace.json": "思考记录.json",
};
const eventLabels = {
  run_started: "运行启动", agent_started: "Agent 开始", supervisor_verdict: "Supervisor 审查",
  human_review_required: "等待人类", human_review: "人类审核", package_promoted: "文件晋级",
  run_completed: "运行完成", config_saved: "配置保存", human_control: "人类控制", input_uploaded: "输入上传", agent_thinking: "Agent 思考",
  agent_decision: "Agent 决策", agent_tool_result: "工具结果", agent_repair_requested: "Agent 修复", agent_blocked: "Agent 阻断",
  llm_generation_completed: "模型完成", llm_generation_failed: "模型失败",
};

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `请求失败 ${response.status}`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

function fileLabel(file) {
  return fileLabels[file.path] || file.name || file.path;
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(file) {
  return file.kind === "text" ? "TXT" : file.kind === "spreadsheet" ? "XLS" : file.kind === "pdf" ? "PDF" : file.kind === "comsol_model" ? "MPH" : "BIN";
}

function render() {
  const data = state.data;
  if (!data) return;
  $("#connectionState").textContent = "服务已连接";
  $("#runChip").textContent = data.runId ? data.status : "未启动";
  $("#pauseButton").textContent = data.status === "paused" ? "继续" : "暂停";
  $("#pauseButton").disabled = !data.runId || ["completed", "aborted"].includes(data.status);
  $("#problemTitle").textContent = data.problem.title;
  $("#problemText").textContent = data.problem.question;
  $("#modeBadge").textContent = data.config.mode.toUpperCase();
  $("#constitutionBadge").textContent = `宪法 ${data.constitution.version} · ${data.constitution.status}`;
  $("#packageBadge").textContent = data.package ? `${data.package.stageKey} · attempt ${data.package.attempt}` : "暂无交接包";
  const completed = data.history.length;
  $("#progressText").textContent = `${completed} / ${data.stages.length}`;
  $("#progressBar").style.width = `${Math.round(completed / data.stages.length * 100)}%`;
  $("#stageStatus").textContent = data.currentStage ? `${data.currentStage.label} · ${data.status}` : "等待启动";
  $("#progressHint").textContent = data.status === "completed" ? "全部阶段完成，最终交付包已冻结。" : "系统会在每个交接包前停下等待人工审核。";
  $("#attentionTitle").textContent = attentionTitle(data.status);
  $("#attentionText").textContent = attentionText(data.status);
  $("#retryAgentButton").hidden = data.status !== "blocked";
  $("#startDemoButton").disabled = Boolean(data.runId && !["completed", "aborted"].includes(data.status));
  renderProject(); renderProgressTree(); renderEvents(); renderHandoff(); renderEvidence(); renderProposal();
}

function renderProject() {
  const project = state.data?.project;
  $("#projectState").textContent = project ? (project.confirmed ? "输入已确认" : "项目已创建") : "尚未创建";
  $("#projectState").className = `badge ${project?.confirmed ? "green" : project ? "blue" : "gray"}`;
  $("#uploadFilesButton").disabled = !project;
  $("#confirmProjectButton").disabled = !project || !project.files?.length || project.confirmed;
  $("#startProjectButton").disabled = !project?.confirmed || Boolean(state.data?.runId && !["completed", "aborted"].includes(state.data.status));
  $("#inputFileList").innerHTML = project?.files?.length ? project.files.map((file) => `<div class="input-file"><strong>${escapeHtml(file.filename)}</strong><span>${file.size} bytes · SHA-256 ${escapeHtml(file.sha256.slice(0, 16))}...</span><small>${escapeHtml(file.excerpt || "")}</small></div>`).join("") : `<span class="muted">创建项目后，输入文件会显示在这里并计算 SHA-256。</span>`;
}

function attentionTitle(status) {
  if (status === "waiting_human_review_1") return "需要人类第一审";
  if (status === "waiting_human_review_2") return "需要人类第二审";
  if (status === "completed") return "演示已完成";
  if (status === "paused") return "运行已暂停";
  if (status === "aborted") return "运行已终止，产物已保留";
  if (status === "blocked") return "当前 Agent 被阻断";
  return "先启动本地演示";
}
function attentionText(status) {
  if (status === "waiting_human_review_1") return "请在“当前交接”中查看结果文档、问题和宪法，再提交第一审意见。";
  if (status === "waiting_human_review_2") return "第一审已记录。请检查代码、stdout、哈希和复现证据，再决定是否放行。";
  if (status === "completed") return "小议题已走完所有阶段；可在审计日志中回放每次交接。";
  if (status === "paused") return "继续后仍会停留在当前合法人工关卡，不会绕过审批。";
  if (status === "blocked") return "模型或工具没有形成可验证交接包。旧 attempt 已保留，可重试当前 Agent；成功后仍必须经过 Supervisor 和两次人类审核。";
  return "演示模式会执行完整的小议题流程，不消耗 API Key。";
}

function renderStagesLegacy() {
  const data = state.data;
  $("#stageGrid").innerHTML = data.stages.map((stage, index) => {
    const done = data.history.some((item) => item.stageIndex === index);
    const active = data.stageIndex === index;
    const waiting = active && ["waiting_human_review_1", "waiting_human_review_2"].includes(data.status);
    const status = done ? "已晋级" : waiting ? (data.status === "waiting_human_review_1" ? "等待第一审" : "等待第二审") : active ? "进行中" : "待开始";
    return `<article class="stage-card ${done ? "done" : ""} ${active ? "active" : ""} ${waiting ? "waiting" : ""}"><span class="stage-number">${String(index + 1).padStart(2, "0")}</span><span class="stage-state">${status}</span><h3>${escapeHtml(stage.label)}</h3><p>${escapeHtml(stage.role)} · ${escapeHtml(stage.brief)}</p><small class="technical-id">${escapeHtml(stage.displayId || stage.technicalId || "")}</small></article>`;
  }).join("");
  $("#blueprintTree").innerHTML = `<div class="blueprint-root"><strong>蓝图 1 · ${escapeHtml(data.problem.title || "未命名议题")}</strong><span class="muted">单人类监督 · Supervisor 闸门 · 双重审核</span></div><div class="blueprint-branch"><span class="branch-mark">└─</span><div><strong>当前执行主线</strong><span class="muted">${escapeHtml(data.currentStage ? `${data.currentStage.displayId || data.currentStage.label} · ${data.status}` : "尚未启动")}</span></div></div><div class="blueprint-legend"><span>✓ 已批准</span><span>● 当前等待</span><span>○ 待开始</span><span>↺ 退回形成新 attempt（历史保留）</span></div>`;
}

function renderProgressTree() {
  const data = state.data;
  const groups = [
    { label: "输入与问题定义", note: "固定题目、数据、宪法和验收条件", indexes: [0, 1] },
    { label: "方案提议与路线决策", note: "提议者提出路线，决策者选择执行方案", indexes: [2, 3, 4, 5, 6, 7] },
    { label: "实验执行与数学核验", note: "规划、执行、复算、结果监督", indexes: [8, 9, 10, 11, 12, 13, 14] },
    { label: "论文、排版与最终交付", note: "只使用已批准证据形成可提交产物", indexes: [15, 16, 17, 18, 19, 20] },
  ];
  const historyFor = (index) => data.history.filter((item) => item.stageIndex === index);
  const statusFor = (index) => {
    const done = historyFor(index).length > 0;
    const active = data.stageIndex === index;
    if (data.status === "aborted" && active) return { key: "aborted", label: "已终止", icon: "×" };
    if (data.status === "blocked" && active) return { key: "blocked", label: "已阻断", icon: "!" };
    if (data.status === "paused" && active) return { key: "paused", label: "已暂停", icon: "Ⅱ" };
    if (done) return { key: "approved", label: "已批准", icon: "✓" };
    if (active && data.status === "waiting_human_review_1") return { key: "review1", label: "等待人类第一审", icon: "●" };
    if (active && data.status === "waiting_human_review_2") return { key: "review2", label: "等待人类第二审", icon: "●" };
    if (active) return { key: "running", label: "进行中", icon: "…" };
    return { key: "pending", label: "待开始", icon: "○" };
  };
  const renderGates = (index, status) => {
    if (status.key === "pending") return "";
    const labels = ["Agent Supervisor", "人类第一审", "人类第二审", "哈希冻结并晋级"];
    return '<div class="tree-gates">' + labels.map((label, gate) => {
      const history = historyFor(index).length > 0;
      const waiting = !history && ((gate === 1 && data.status === "waiting_human_review_1") || (gate === 2 && data.status === "waiting_human_review_2"));
      const complete = history || gate === 0;
      const key = waiting ? "current" : complete ? "done" : "pending";
      const icon = key === "done" ? "✓" : key === "current" ? "●" : "○";
      return '<span class="tree-gate ' + key + '"><i>' + icon + '</i>' + label + '<small>' + (waiting ? "当前等待" : complete ? "已完成" : "待开始") + '</small></span>';
    }).join("") + '</div>';
  };
  const renderStage = (stage, index) => {
    const status = statusFor(index);
    const revisions = (data.revisionRequests || []).filter((item) => item.stageKey === stage.key);
    const history = historyFor(index);
    const packageLabel = index === data.stageIndex && data.package ? "当前包 " + data.package.packageId + " · attempt " + data.package.attempt : history.length ? history.length + " 个已批准版本" : "";
    const revisionHtml = revisions.length ? '<div class="tree-revisions">' + revisions.map((item) => '<div class="tree-revision"><span>↺</span><span><strong>修订分支</strong> · ' + escapeHtml(item.notes) + '<small>' + escapeHtml(item.packageId) + ' · ' + escapeHtml(item.category || "一般") + ' · 历史保留</small></span></div>').join("") + '</div>' : "";
    return '<details class="tree-node ' + status.key + (index === data.stageIndex ? " current-node" : "") + '"' + (index === data.stageIndex ? " open" : "") + '><summary><span class="tree-status-icon">' + status.icon + '</span><span class="tree-node-index">' + String(index + 1).padStart(2, "0") + '</span><span class="tree-node-main"><strong>' + escapeHtml(stage.label) + '</strong><small>' + escapeHtml(stage.role) + ' · ' + escapeHtml(stage.brief) + '</small></span><span class="tree-node-state">' + status.label + '</span></summary><div class="tree-node-body"><div class="tree-node-meta"><span>' + escapeHtml(stage.displayId || stage.technicalId || "") + '</span><span>' + escapeHtml(packageLabel) + '</span></div>' + renderGates(index, status) + revisionHtml + '</div></details>';
  };
  const groupHtml = groups.map((group) => {
    const completed = group.indexes.filter((index) => historyFor(index).length > 0).length;
    const active = group.indexes.includes(data.stageIndex);
    const icon = active ? "●" : completed === group.indexes.length ? "✓" : "○";
    return '<details class="tree-group' + (active ? " active-group" : "") + '"' + (active ? " open" : "") + '><summary><span class="tree-branch-mark">' + icon + '</span><span class="tree-group-main"><strong>' + escapeHtml(group.label) + '</strong><small>' + escapeHtml(group.note) + '</small></span><span class="tree-group-count">' + completed + " / " + group.indexes.length + '</span></summary><div class="tree-group-children">' + group.indexes.map((index) => renderStage(data.stages[index], index)).join("") + '</div></details>';
  }).join("");
  $("#progressTree").innerHTML = '<div class="progress-tree-root"><div><strong>蓝图 1 · ' + escapeHtml(data.problem.title || "未命名议题") + '</strong><small>' + (data.runId ? escapeHtml(data.runId) + " · " + escapeHtml(data.status) : "尚未启动") + '</small></div><span class="tree-root-rule">唯一人类 · Supervisor · 双重审核</span></div><div class="tree-groups">' + groupHtml + '</div><div class="blueprint-legend"><span>✓ 已批准并点亮</span><span>● 当前等待人工</span><span>○ 待开始</span><span>! 阻断 / × 终止</span><span>↺ 修订分支（历史保留）</span></div>';
}

function renderEvents() {
  const events = state.events.slice(-80).reverse();
  const html = events.length ? events.map(eventRow).join("") : `<div class="event-row"><span class="message">暂无事件</span></div>`;
  $("#eventList").innerHTML = html; $("#overviewEvents").innerHTML = events.slice(0, 8).map(eventRow).join("");
}

function eventRow(event) {
  const time = new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const message = event.displayMessage || event.message || event.decision || event.action || event.stageLabel || "状态变化";
  const title = event.displayTitle || event.stageLabel || event.type || "工作流事件";
  return `<div class="event-row" title="${escapeHtml(title)}"><span class="seq">#${event.sequence}</span><span class="time">${time}</span><span class="event-type">${eventLabels[event.type] || escapeHtml(event.type)}</span><span class="message">${escapeHtml(message)}</span></div>`;
}

function renderHandoff() {
  const data = state.data; const pkg = data.package; const waiting = data.status === "waiting_human_review_1" || data.status === "waiting_human_review_2";
  $("#handoffTitle").textContent = pkg ? `${data.currentStage.label} · ${pkg.packageId}` : "暂无待审核交接";
  $("#handoffState").textContent = pkg ? data.status : "未开始";
  ["gateSupervisor", "gateHuman1", "gateHuman2", "gatePromotion"].forEach((id) => $("#" + id).classList.remove("current", "blocked"));
  $("#gateSupervisor").classList.add("done");
  if (data.status === "waiting_human_review_1") $("#gateHuman1").classList.add("current");
  if (data.status === "waiting_human_review_2") { $("#gateHuman1").classList.add("done"); $("#gateHuman2").classList.add("current"); }
  if (data.history.some((item) => item.packageId === pkg?.packageId)) { $("#gateHuman1").classList.add("done"); $("#gateHuman2").classList.add("done"); $("#gatePromotion").classList.add("done"); }
  const files = pkg?.files || [];
  if (files.length && !files.some((file) => file.path === state.activeFile)) state.activeFile = files[0].path;
  $("#fileTabs").innerHTML = files.length ? `<div class="package-summary"><strong>${files.length} 个文件</strong><span>全部文件都随本包交接，逐个记录哈希；文本可在线查看，专用格式请下载。</span></div><div class="package-files">${files.map((file) => `<div class="package-file ${state.activeFile === file.path ? "active" : ""}"><span class="file-type">${fileIcon(file)}</span><div class="package-file-info"><strong title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</strong><small>${fileSize(file.size)} · SHA-256 ${escapeHtml(file.sha256.slice(0, 16))}... · ${file.previewable ? "可在线查看" : "下载后打开"}</small></div><button class="button ghost small" data-file="${escapeHtml(file.path)}">${file.previewable ? "查看" : "详情"}</button><a class="button ghost small" href="/api/framework/download?path=${encodeURIComponent(`${pkg.dir}/${file.path}`)}" download>下载</a></div>`).join("")}</div>` : `<span class="muted">当前交接包没有文件。</span>`;
  document.querySelectorAll("[data-file]").forEach((button) => button.addEventListener("click", () => { state.activeFile = button.dataset.file; loadArtifact(); }));
  $("#reviewForm").style.display = waiting ? "block" : "none";
  $("#reviewHelp").textContent = data.status === "waiting_human_review_1" ? "第一审：内容、目标、问题清单和宪法。" : "第二审：代码、stdout、哈希、复现和放行范围。";
  $("#supervisorBadge").textContent = pkg?.supervisor?.decision === "submit_for_human_review" ? "通过" : "阻断";
  $("#supervisorDetails").innerHTML = pkg?.supervisor ? Object.entries({"宪法": pkg.supervisor.constitutional_status, "技术": pkg.supervisor.technical_status, "证据": pkg.supervisor.evidence_status, "复现": pkg.supervisor.reproducibility_status}).map(([key, value]) => `<div class="detail-item"><span>${key}</span><strong>${escapeHtml(value)}</strong></div>`).join("") : `<div class="detail-item"><span>状态</span><strong>尚未生成</strong></div>`;
  if (pkg) loadArtifact(); else { $("#fileName").textContent = "选择文件"; $("#fileContent").textContent = "启动演示后，这里会显示当前交接包。"; }
}

async function loadArtifact() {
  const pkg = state.data?.package; if (!pkg) return;
  try { const result = await api(`/api/framework/artifact?path=${encodeURIComponent(`${pkg.dir}/${state.activeFile}`)}`); const file = pkg.files.find((item) => item.path === state.activeFile); $("#fileName").textContent = fileLabel(file || { path: state.activeFile, name: state.activeFile }); $("#fileHash").textContent = `${fileSize(result.size)} · SHA-256 ${file?.sha256?.slice(0, 16) || ""}...`; $("#fileDownload").href = `/api/framework/download?path=${encodeURIComponent(`${pkg.dir}/${state.activeFile}`)}`; $("#fileContent").textContent = result.previewable ? result.content : result.message; } catch (error) { $("#fileContent").textContent = error.message; }
}

function renderEvidence() {
  const data = state.data; const pkg = data.package; const approvals = data.humanReviews.filter((item) => item.packageId === pkg?.packageId && item.decision === "approve").length;
  $("#evidenceCode").textContent = pkg?.execution?.ok ? "成功" : pkg ? "失败" : "未运行";
  $("#evidenceSupervisor").textContent = pkg?.supervisor ? pkg.supervisor.decision : "未检查";
  $("#evidenceApprovals").textContent = `${Math.min(approvals, 2)} / 2`;
  $("#artifactList").innerHTML = pkg ? (pkg.files || []).map((file) => `<div class="artifact"><strong>${fileIcon(file)} · ${escapeHtml(file.path)}</strong><span>${fileSize(file.size)} · SHA-256 ${escapeHtml(file.sha256.slice(0, 16))}...</span><a class="artifact-link" href="/api/framework/download?path=${encodeURIComponent(`${pkg.dir}/${file.path}`)}" download>下载</a></div>`).join("") : "";
  if (pkg) api(`/api/framework/artifact?path=${encodeURIComponent(`${pkg.dir}/stdout.txt`)}`).then((result) => { $("#stdoutView").textContent = result.content || "（无 stdout）"; }).catch(() => {});
}

function renderProposal() {
  const stage = state.data?.currentStage;
  $("#roleBrief").textContent = stage ? `${stage.role}（${stage.agent}）当前负责“${stage.label}”：${stage.brief} 该 Agent 不能越过 Supervisor 和人类关卡。` : "启动演示后，这里会显示当前 Agent 的职责和输入输出边界。";
  loadReasoningTrace();
}

async function loadReasoningTrace() {
  const pkg = state.data?.package; if (!pkg || !$("#reasoningTrace")) return;
  try {
    const result = await api(`/api/framework/artifact?path=${encodeURIComponent(`${pkg.dir}/reasoning_trace.json`)}`);
    const trace = JSON.parse(result.content);
    const list = (value) => Array.isArray(value) ? value : value ? [value] : [];
    const lines = (value, separator = "<br>") => list(value).map(escapeHtml).join(separator) || "无记录";
    const inputs = list(trace.approved_inputs).map((x) => escapeHtml(x.filename || x.path || x)).join("、") || "无";
    $("#reasoningTrace").innerHTML = `<div class="trace-summary"><strong>${escapeHtml(trace.objective || trace.decision || "本节点结构化推理记录")}</strong><span>${escapeHtml(trace.result || "")}</span></div><div class="trace-grid"><div><b>已批准输入</b><p>${inputs}</p></div><div><b>观察事实</b><p>${lines(trace.observations)}</p></div><div><b>假设</b><p>${lines(trace.hypotheses)}</p></div><div><b>替代方案</b><p>${lines(trace.alternatives)}</p></div><div><b>选择与依据</b><p>${escapeHtml(trace.decision || "未记录")}<br>${lines(trace.decision_basis)}</p></div><div><b>工具计划</b><p>${lines(trace.tool_plan, " · ")}</p></div><div><b>检查结果</b><p>${lines(trace.checks)}</p></div><div><b>不确定性 / 下一步</b><p>${lines(trace.uncertainty)}<br>${escapeHtml(trace.next_action || "未记录")}</p></div></div>`;
  } catch (error) { $("#reasoningTrace").textContent = error.message; }
}

async function refresh() { try { state.data = await api("/api/framework/state"); state.events = state.data.events || []; render(); } catch (error) { $("#connectionState").textContent = `连接失败：${error.message}`; } }

function connectEvents() {
  const source = new EventSource("/api/framework/events");
  source.addEventListener("framework", (message) => { const event = JSON.parse(message.data); if (!state.events.some((item) => item.sequence === event.sequence)) state.events.push(event); if (state.data) { state.data.events = state.events; } render(); });
  source.onerror = () => { $("#connectionState").textContent = "事件流重连中"; };
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.jump)));
function showView(name) { document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name)); document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`)); $("#pageTitle").textContent = { overview: "项目总览", handoff: "当前交接", proposal: "提案与决策", evidence: "执行证据", audit: "审计日志", settings: "模型设置" }[name]; }

$("#startDemoButton").addEventListener("click", async () => { try { await api("/api/framework/demo/start", { method: "POST", body: "{}" }); showView("handoff"); await refresh(); } catch (error) { alert(error.message); } });
$("#retryAgentButton").addEventListener("click", async () => { try { await api("/api/framework/retry-agent", { method: "POST", body: "{}" }); showView("handoff"); await refresh(); } catch (error) { alert(error.message); } });
$("#createProjectButton").addEventListener("click", async () => { try { await api("/api/framework/project", { method: "POST", body: JSON.stringify({ title: $("#projectTitle").value }) }); $("#intakeMessage").textContent = "项目已创建，请选择题目和数据文件。"; await refresh(); } catch (error) { $("#intakeMessage").textContent = error.message; } });
$("#uploadFilesButton").addEventListener("click", async () => { const folderFiles = [...$("#folderFiles").files]; const files = folderFiles.length ? folderFiles : [...$("#problemFile").files, ...$("#dataFile").files].filter(Boolean); if (!files.length) { $("#intakeMessage").textContent = "请先选择题目文件和数据/模板文件，或选择整个题目文件夹。"; return; } try { const allowed = files.filter((file) => /\.(pdf|docx|md|txt|json|csv|xlsx|xls|py|cpp|c|h|hpp|html|css|js|tex|m|mph)$/i.test(file.name)); const form = new FormData(); allowed.forEach((file) => form.append("files", file, file.webkitRelativePath || file.name)); const response = await fetch("/api/framework/upload", { method: "POST", body: form }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "上传失败"); $("#intakeMessage").textContent = `已上传 ${body.files.length} 个有效文件，并完成分类和哈希登记。`; await refresh(); } catch (error) { $("#intakeMessage").textContent = error.message; } });
$("#confirmProjectButton").addEventListener("click", async () => { const project = state.data?.project; if (!project) return; try { await api(`/api/framework/project/${encodeURIComponent(project.id)}/confirm`, { method: "POST", body: JSON.stringify({ title: $("#projectTitle").value }) }); $("#intakeMessage").textContent = "题目与数据已确认，可以启动项目。"; await refresh(); } catch (error) { $("#intakeMessage").textContent = error.message; } });
$("#startProjectButton").addEventListener("click", async () => { const project = state.data?.project; if (!project) return; try { await api(`/api/framework/project/${encodeURIComponent(project.id)}/start`, { method: "POST", body: "{}" }); showView("handoff"); await refresh(); } catch (error) { $("#intakeMessage").textContent = error.message; } });
$("#pauseButton").addEventListener("click", async () => { try { await api("/api/framework/control", { method: "POST", body: JSON.stringify({ action: state.data?.status === "paused" ? "resume" : "pause" }) }); await refresh(); } catch (error) { alert(error.message); } });
$("#abortButton").addEventListener("click", async () => { if (!confirm("终止当前运行？所有产物和日志会保留。")) return; try { await api("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) }); await refresh(); } catch (error) { alert(error.message); } });
document.addEventListener("click", async (event) => { const button = event.target.closest("[data-review]"); if (!button) return; const data = state.data; const notes = $("#reviewNotes").value.trim(); if (notes.length < 2) { alert("请先填写具体审核意见。"); $("#reviewNotes").focus(); return; } const gate = data.status === "waiting_human_review_1" ? "content" : "evidence"; const targetFiles = $("#reviewTargetFiles").value.split(",").map((item) => item.trim()).filter(Boolean); try { await api("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId: data.package.packageId, gate, decision: button.dataset.review, notes, category: $("#reviewCategory").value, targetFiles, severity: button.dataset.review === "return" ? "blocking" : "normal" }) }); $("#reviewNotes").value = ""; $("#reviewTargetFiles").value = ""; await refresh(); } catch (error) { alert(error.message); } });
$("#saveConfigButton").addEventListener("click", async () => { const key = $("#configKey").value; try { const result = await api("/api/framework/config", { method: "POST", body: JSON.stringify({ mode: $("#configMode").value, apiBase: $("#configBase").value, model: $("#configModel").value, apiKey: key || "__KEEP__" }) }); $("#configSaved").textContent = "已保存"; $("#configKey").value = ""; $("#configMessage").textContent = `已保存：${result.mode} / ${result.apiBase}`; await refresh(); } catch (error) { $("#configMessage").textContent = error.message; } });
$("#testConfigButton").addEventListener("click", async () => { try { const result = await api("/api/framework/config/test", { method: "POST", body: "{}" }); $("#configMessage").textContent = result.message; } catch (error) { $("#configMessage").textContent = error.message; } });

refresh(); connectEvents();
