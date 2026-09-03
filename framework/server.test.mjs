import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = 24000 + Math.floor(Math.random() * 1000);
const dataDir = await mkdtemp(resolve(tmpdir(), "supervised-framework-"));
const projectRoot = resolve(import.meta.dirname, "..");
let child;

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/framework/health`)).ok) return; } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("framework server did not start");
}

async function json(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "content-type": "application/json" }, ...options });
  return { response, body: await response.json() };
}

test.before(async () => {
  child = spawn(process.execPath, ["framework/server.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, FRAMEWORK_PORT: String(port), FRAMEWORK_DATA_DIR: dataDir, FRAMEWORK_FAST_TEST: "1" },
    windowsHide: true,
    stdio: "ignore",
  });
  await waitReady();
});

test.after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test("演示模式完整通过 Supervisor、单人双审核和原子晋级", async () => {
  const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
  assert.equal(started.response.status, 202);
  let current = started.body.state;
  assert.equal(current.status, "waiting_human_review_1");
  assert.equal(current.currentStage.agent, "problem-intake");
  assert.ok(current.package.files.length >= 10);
  assert.ok(current.package.files.every((file) => file.path && typeof file.sha256 === "string" && typeof file.size === "number"));
  assert.ok(current.package.files.some((file) => file.path === "reasoning_trace.json"));
  assert.ok(current.package.files.some((file) => file.path === "result_code.py"));

  for (let stage = 0; stage < current.stages.length; stage += 1) {
    assert.equal(current.status, "waiting_human_review_1");
    const packageId = current.package.packageId;
    const first = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "content", decision: "approve", notes: "内容和宪法已检查" }) });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.status, "waiting_human_review_2");
    const second = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "evidence", decision: "approve", notes: "证据、代码、哈希已检查，允许放行" }) });
    assert.equal(second.response.status, 200);
    current = second.body;
    assert.equal(current.humanReviews.filter((review) => review.packageId === packageId && review.decision === "approve").length, 2);
    if (stage < current.stages.length - 1) assert.equal(current.status, "waiting_human_review_1");
  }
  assert.equal(current.status, "completed");
  assert.equal(current.history.length, current.stages.length);
  assert.equal(current.humanReviews.filter((review) => review.decision === "approve").length, current.stages.length * 2);
  assert.ok(current.events.some((event) => event.type === "run_completed"));
});

test("退回交接会生成新 attempt，不能复用旧包", async () => {
  const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
  const oldPackage = started.body.state.package.packageId;
  const returned = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId: oldPackage, gate: "content", decision: "return", notes: "补充边界条件" }) });
  assert.equal(returned.body.status, "waiting_human_review_1");
  assert.notEqual(returned.body.package.packageId, oldPackage);
  assert.equal(returned.body.package.attempt, 2);
});

test("演示模式不需要 API Key", async () => {
  const result = await json("/api/framework/config/test", { method: "POST", body: "{}" });
  assert.equal(result.body.ok, true);
  assert.match(result.body.message, /不需要/);
});

test("项目输入通过 WebUI 上传、确认后才允许启动", async () => {
  const existing = (await json("/api/framework/state")).body;
  if (existing.runId && !["completed", "aborted"].includes(existing.status)) {
    const stopped = await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) });
    assert.equal(stopped.response.status, 200);
  }
  const created = await json("/api/framework/project", { method: "POST", body: JSON.stringify({ title: "上传练习题" }) });
  assert.equal(created.response.status, 201);
  const projectId = created.body.project.id;
  const form = new FormData();
  form.append("files", new Blob(["# 上传题目\n计算四个站点的缺车量。"], { type: "text/markdown" }), "题目.md");
  form.append("files", new Blob(["station,demand_morning,initial_bikes\nA,18,10\nB,7,12\n"], { type: "text/csv" }), "数据.csv");
  form.append("files", new Blob(["station,note\nC,\"含逗号,的备注\"\nD,\"跨行\n备注\"\n"], { type: "text/csv" }), "补充数据.csv");
  form.append("files", new Blob(["template-1"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "result1.xlsx");
  form.append("files", new Blob(["template-2"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "result2.xlsx");
  form.append("files", new Blob(["template-3"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "result3.xlsx");
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/framework/upload`, { method: "POST", body: form });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.equal(upload.files.length, 6);
  assert.ok(upload.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  const confirmed = await json(`/api/framework/project/${projectId}/confirm`, { method: "POST", body: JSON.stringify({ title: "上传练习题" }) });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.state.project.confirmed, true);
  const started = await json(`/api/framework/project/${projectId}/start`, { method: "POST", body: "{}" });
  assert.equal(started.response.status, 202);
  assert.equal(started.body.state.status, "waiting_human_review_1");
  assert.equal(started.body.state.problem.rows.length, 4);
  assert.equal(started.body.state.problem.files.length, 6);
  assert.deepEqual(started.body.state.problem.rows.map((row) => row.__source_file), ["数据.csv", "数据.csv", "补充数据.csv", "补充数据.csv"]);
  assert.equal(started.body.state.problem.rows[2].note, "含逗号,的备注");
  assert.equal(started.body.state.problem.rows[3].note, "跨行\n备注");
});

test("A 题执行节点交接完整保留多类型 Agent 文件", async () => {
  await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) });
  const created = await json("/api/framework/project", { method: "POST", body: JSON.stringify({ title: "A 题多类型文件测试" }) });
  const projectId = created.body.project.id;
  const form = new FormData();
  form.append("files", new Blob(["A 题 烟幕干扰弹投放策略"], { type: "text/plain" }), "A题_text.txt");
  for (const name of ["result1.xlsx", "result2.xlsx", "result3.xlsx"]) form.append("files", new Blob([name], { type: "application/octet-stream" }), name);
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/framework/upload`, { method: "POST", body: form });
  assert.equal(uploadResponse.status, 201);
  await json(`/api/framework/project/${projectId}/confirm`, { method: "POST", body: JSON.stringify({ title: "A 题多类型文件测试" }) });
  let current = (await json(`/api/framework/project/${projectId}/start`, { method: "POST", body: "{}" })).body.state;
  for (let index = 0; index < 9; index += 1) {
    const packageId = current.package.packageId;
    current = (await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "content", decision: "approve", notes: "内容审" }) })).body;
    current = (await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "evidence", decision: "approve", notes: "证据审" }) })).body;
  }
  assert.equal(current.currentStage.key, "python_executor");
  assert.ok(current.package.files.some((file) => file.path === "agent_outputs/a_solver.py"));
  assert.ok(current.package.files.some((file) => file.path === "agent_outputs/model_check.cpp"));
  assert.ok(current.package.files.some((file) => file.path === "agent_outputs/result_report.html"));
  assert.ok(current.package.files.some((file) => file.path.startsWith("incoming/")));
  assert.ok(current.package.files.find((file) => file.path === "agent_outputs/model_check.cpp").previewable);
  assert.equal((await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) })).body.status, "aborted");
});

test("完整交接链递归保留原始输入和多类型产物", async () => {
  const created = await json("/api/framework/project", { method: "POST", body: JSON.stringify({ title: "A 题递归交接测试" }) });
  const projectId = created.body.project.id;
  const form = new FormData();
  form.append("files", new Blob(["A 题 烟幕干扰弹投放策略"], { type: "text/plain" }), "A题_text.txt");
  form.append("files", new Blob(["item,value\nalpha,1\nbeta,2\n"], { type: "text/csv" }), "data.csv");
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/framework/upload`, { method: "POST", body: form });
  assert.equal(uploadResponse.status, 201);
  await json(`/api/framework/project/${projectId}/confirm`, { method: "POST", body: JSON.stringify({ title: "A 题递归交接测试" }) });
  let current = (await json(`/api/framework/project/${projectId}/start`, { method: "POST", body: "{}" })).body.state;
  for (let index = 0; index < current.stages.length; index += 1) {
    const packageId = current.package.packageId;
    current = (await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "content", decision: "approve", notes: "内容审" }) })).body;
    current = (await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "evidence", decision: "approve", notes: "证据审" }) })).body;
  }
  assert.equal(current.status, "completed");
  assert.equal(current.humanReviews.filter((review) => review.decision === "approve").length, current.stages.length * 2);
  assert.ok(current.package.files.some((file) => file.path.endsWith("incoming/inputs/A题_text.txt")));
  assert.ok(current.package.files.some((file) => file.path.endsWith("/agent_outputs/a_solver.py")));
  assert.ok(current.package.files.some((file) => file.path.endsWith("/agent_outputs/model_check.cpp")));
  assert.ok(current.package.files.some((file) => file.path.endsWith("/agent_outputs/result_report.html")));
});

test("审批意见不能为空，退回会形成结构化修订请求", async () => {
  const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
  const packageId = started.body.state.package.packageId;
  const empty = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "content", decision: "approve", notes: " " }) });
  assert.equal(empty.response.status, 400);
  const returned = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "content", decision: "return", notes: "补充边界条件", category: "数学", targetFiles: ["result_code.py"], severity: "blocking" }) });
  assert.equal(returned.response.status, 200);
  assert.equal(returned.body.status, "waiting_human_review_1");
  assert.equal(returned.body.revisionRequests.at(-1).packageId, packageId);
  assert.deepEqual(returned.body.revisionRequests.at(-1).targetFiles, ["result_code.py"]);
  assert.equal(returned.body.revisionRequests.at(-1).category, "数学");
  assert.equal((await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) })).body.status, "aborted");
});

test("输入文件拒绝同名覆盖，确认后拒绝追加输入", async () => {
  const created = await json("/api/framework/project", { method: "POST", body: JSON.stringify({ title: "输入安全测试" }) });
  const projectId = created.body.project.id;
  const upload = async (name, content) => {
    const form = new FormData();
    form.append("files", new Blob([content], { type: "text/plain" }), name);
    const response = await fetch(`http://127.0.0.1:${port}/api/framework/upload`, { method: "POST", body: form });
    return { response, body: await response.json() };
  };
  assert.equal((await upload("题目.txt", "题目")).response.status, 201);
  assert.equal((await upload("题目.txt", "替换内容")).response.status, 409);
  const dataForm = new FormData();
  dataForm.append("files", new Blob(["x,y\n1,2\n"], { type: "text/csv" }), "数据.csv");
  const dataResponse = await fetch(`http://127.0.0.1:${port}/api/framework/upload`, { method: "POST", body: dataForm });
  assert.equal(dataResponse.status, 201);
  assert.equal((await json(`/api/framework/project/${projectId}/confirm`, { method: "POST", body: JSON.stringify({ title: "输入安全测试" }) })).response.status, 200);
  const afterConfirm = await upload("新数据.csv", "x,y\n3,4\n");
  assert.equal(afterConfirm.response.status, 409);
});

test("终止后不能再次控制，产物接口不能读取项目源文件", async () => {
  const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
  const packageId = started.body.state.package.packageId;
  const first = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "content", decision: "approve", notes: "内容审" }) });
  const second = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId, gate: "evidence", decision: "approve", notes: "证据审" }) });
  assert.equal(second.body.status, "waiting_human_review_1");
  const stopped = await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) });
  assert.equal(stopped.response.status, 200);
  const finishedControl = await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "resume" }) });
  assert.equal(finishedControl.response.status, 409);
  const forbidden = await json("/api/framework/artifact?path=package.json");
  assert.equal(forbidden.response.status, 403);
});

test("拒绝跨来源状态变更，并提供完整审计历史读取入口", async () => {
  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/framework/project`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ title: "跨来源请求" }) });
  assert.equal(crossOrigin.status, 403);
  const history = await json("/api/framework/events/history?after=0&limit=10");
  assert.equal(history.response.status, 200);
  assert.ok(Array.isArray(history.body.events));
  assert.ok(history.body.events.every((event) => event.sequence > 0));
  assert.ok(typeof history.body.nextAfter === "number");
});

test("live Agent 必须由模型产出代码和真实结构化推理，再交给 Supervisor", async () => {
  const fakePort = 27000 + Math.floor(Math.random() * 500);
  const fake = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const requestBody = JSON.parse(body || "{}");
    const system = requestBody.messages?.[0]?.content || "";
    const isSupervisor = system.includes("独立 Agent Supervisor");
    const payload = isSupervisor ? {
      decision: "submit_for_human_review",
      constitutional_status: "pass",
      technical_status: "feasible",
      evidence_status: "complete",
      reproducibility_status: "pass",
      blocking_issues: [],
      required_repairs: [],
      supervisor_basis: ["已检查 live Agent 文件、执行证据和宪法版本"],
    } : {
      files: [{ path: "result_code.py", purpose: "live Agent 选择的最小可执行验证器", content: "print('live-agent-code')\n" }, { path: "agent_outputs/decision.txt", purpose: "记录本节点的选择", content: "选择：确定性最小验证器\n" }],
      document_markdown: "# live Agent 文档\n\n本内容来自模型响应。",
      issues_markdown: "# live Agent 问题\n\n需要人类复核输入和证据。",
      improvement_markdown: "# live Agent 改进\n\n下一步由后续节点验证。",
      reasoning: {
        observations: ["模型看到题目和已批准输入"],
        hypotheses: ["最小验证器足以先确认执行链"],
        alternatives: ["直接生成完整论文；先做可执行基线"],
        decision: "先执行可复现基线",
        decision_basis: ["先验证输入、代码和证据链，再扩展复杂模型"],
        tool_plan: ["写入 result_code.py", "运行 Python", "读取 stdout 和 stderr"],
        checks: ["检查返回码为 0", "核对 stdout 中的 live-agent-code"],
        result: "等待工具执行证据",
        uncertainty: ["尚未证明模型质量和数学最优性"],
        next_action: "将执行证据交给 Supervisor 和唯一人类双审",
      },
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "fake-cheap-model", choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 1 } }));
  });
  await new Promise((resolveListen) => fake.listen(fakePort, "127.0.0.1", resolveListen));
  try {
    const saved = await json("/api/framework/config", { method: "POST", body: JSON.stringify({ mode: "live", apiBase: "http://127.0.0.1:" + fakePort + "/v1", model: "fake-cheap-model", apiKey: "test-key" }) });
    assert.equal(saved.response.status, 200);
    const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.state.status, "waiting_human_review_1");
    const pkg = started.body.state.package;
    const executionLog = await json("/api/framework/artifact?path=" + encodeURIComponent(pkg.dir + "/execution_log.json"));
    assert.match(executionLog.body.content, /executed_code_sha256/);
    assert.match(executionLog.body.content, /codeSha256|executed_code_sha256/);
    const code = await json("/api/framework/artifact?path=" + encodeURIComponent(pkg.dir + "/result_code.py"));
    assert.equal(code.body.content, "print('live-agent-code')\n");
    const trace = await json("/api/framework/artifact?path=" + encodeURIComponent(pkg.dir + "/reasoning_trace.json"));
    assert.match(trace.body.content, /先验证输入、代码和证据链/);
    assert.equal(pkg.supervisor.decision, "submit_for_human_review");
    assert.ok(started.body.state.events.some((event) => event.type === "agent_decision"));
    const stopped = await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) });
    assert.equal(stopped.response.status, 200);
  } finally {
    await new Promise((resolveClose) => fake.close(resolveClose));
  }
});

test("live Agent 生成失败时必须 blocked，不能进入人类审核", async () => {
  const fakePort = 27500 + Math.floor(Math.random() * 400);
  const fake = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const requestBody = JSON.parse(body || "{}");
    const isSupervisor = (requestBody.messages?.[0]?.content || "").includes("独立 Agent Supervisor");
    const payload = isSupervisor ? {
      decision: "submit_for_human_review", constitutional_status: "pass", technical_status: "feasible",
      evidence_status: "complete", reproducibility_status: "pass", blocking_issues: [], required_repairs: [], supervisor_basis: ["假端点结论"],
    } : {
      // Deliberately invalid: a live Agent may never rely on framework demo code.
      files: [{ path: "notes.md", content: "missing result_code.py" }],
      document_markdown: "document", issues_markdown: "issues", improvement_markdown: "improvement",
      reasoning: { observations: ["x"], alternatives: ["a"], decision: "a", decision_basis: ["b"], tool_plan: ["c"], checks: ["d"], next_action: "e" },
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "fake-model", choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
  await new Promise((resolveListen) => fake.listen(fakePort, "127.0.0.1", resolveListen));
  try {
    await json("/api/framework/config", { method: "POST", body: JSON.stringify({ mode: "live", apiBase: "http://127.0.0.1:" + fakePort + "/v1", model: "fake-model", apiKey: "test-key" }) });
    const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.state.status, "blocked");
    assert.equal(started.body.state.package.supervisor.decision, "revise");
    assert.equal(started.body.state.events.some((event) => event.type === "human_review_required" && event.packageId === started.body.state.package.packageId), false);
    const attemptedReview = await json("/api/framework/review", { method: "POST", body: JSON.stringify({ packageId: started.body.state.package.packageId, gate: "content", decision: "approve", notes: "不应允许" }) });
    assert.equal(attemptedReview.response.status, 409);
  } finally {
    await new Promise((resolveClose) => fake.close(resolveClose));
  }
});

test("阻断节点可以安全重试并生成新 attempt", async () => {
  await json("/api/framework/config", { method: "POST", body: JSON.stringify({ mode: "live", apiBase: "http://127.0.0.1:1/v1", model: "", apiKey: "" }) });
  const started = await json("/api/framework/demo/start", { method: "POST", body: "{}" });
  assert.equal(started.body.state.status, "blocked");
  assert.ok(started.body.state.package.files.some((file) => file.path === "input_integrity.json"));
  const blockedPause = await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "pause" }) });
  assert.equal(blockedPause.response.status, 409);
  const oldPackage = started.body.state.package.packageId;
  const returned = await json("/api/framework/retry-agent", { method: "POST", body: "{}" });
  assert.equal(returned.response.status, 202);
  assert.notEqual(returned.body.state.package.packageId, oldPackage);
  assert.equal(returned.body.state.package.attempt, 2);
  assert.equal(returned.body.state.status, "blocked");
  assert.ok(returned.body.state.events.some((event) => event.type === "agent_retry_requested" && event.packageId === oldPackage));
  await json("/api/framework/control", { method: "POST", body: JSON.stringify({ action: "abort" }) });
});
