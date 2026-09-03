import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(frontendDir, "..");
const fakeMathAgent = resolve(frontendDir, "test-fixtures", "fake-math-agent.mjs");
const port = 20_000 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
let child;
let stderr = "";

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}

async function waitForRunStatus(runId, expectedStatus) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
    if (response.ok) {
      const run = await response.json();
      if (run.status === expectedStatus) return run;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus}`);
}

test.before(async () => {
  child = spawn(process.execPath, ["frontend/server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MATH_AGENT_COMMAND: `"${process.execPath}" "${fakeMathAgent}"`,
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitUntilReady();
});

test.after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveClose) => child.once("close", resolveClose)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ]);
});

test("健康接口与静态首页可访问", async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /automcm-pro/);
  assert.match(html, /三步开始你的数学建模任务/);
  assert.match(html, /id="runPipeline" disabled/);
  assert.match(html, /<details class="advanced-disclosure">/);
});

test("API 拒绝非法 JSON、超大请求和非法模板", async () => {
  const invalidJson = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad",
  });
  assert.equal(invalidJson.status, 400);

  const tooLarge = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ background: "x".repeat(1024 * 1024 + 1) }),
  });
  assert.equal(tooLarge.status, 413);

  const invalidTemplate = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ template: "gmcn" }),
  });
  assert.equal(invalidTemplate.status, 400);
});

test("产物接口禁止访问项目目录之外", async () => {
  const response = await fetch(`${base}/api/artifacts?out=${encodeURIComponent("../outside")}`);
  assert.equal(response.status, 403);
});

test("POST /api/upload 接受 CSV 附件并返回摘要", async () => {
  const boundary = "----testboundary12345";
  const csvContent = "name,value\nAlice,30\nBob,25\n";
  const body = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="purpose"\r\n\r\n`,
    `attachment\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="test.csv"\r\n`,
    `Content-Type: text/csv\r\n\r\n`,
    csvContent,
    `\r\n--${boundary}--\r\n`,
  ].join("");

  const response = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.filename, "test.csv");
  assert.equal(data.fileType, "csv");
  assert.ok(data.summary);
  assert.ok(data.summary.sheets || data.summary.text_excerpt);
  assert.ok(data.id);
});

test("POST /api/upload 拒绝不支持的文件类型", async () => {
  const boundary = "----testboundary99999";
  const body = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="purpose"\r\n\r\n`,
    `attachment\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="evil.exe"\r\n`,
    `Content-Type: application/octet-stream\r\n\r\n`,
    `binarydata`,
    `\r\n--${boundary}--\r\n`,
  ].join("");

  const response = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(response.status, 415);
});

test("POST /api/run 接受 attachments 并写入 problem.json", async () => {
  // 先上传一个文件
  const boundary = "----testboundary777";
  const csvContent = "a,b\n1,2\n";
  const uploadBody = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="purpose"\r\n\r\n`,
    `attachment\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="data.csv"\r\n\r\n`,
    csvContent,
    `\r\n--${boundary}--\r\n`,
  ].join("");
  const uploadRes = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: uploadBody,
  });
  const uploadData = await uploadRes.json();

  // 启动 run
  const runRes = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "test",
      background: "test bg",
      outputDir: "runs/ui-test-attachments",
      threadId: "test-att",
      noInterrupt: true,
      ragEnabled: false,
      attachments: [uploadData],
    }),
  });
  assert.equal(runRes.status, 202);
  const runJson = await runRes.json();
  assert.ok(runJson.run.id);

  // 清理：stop the run
  await fetch(`${base}/api/runs/${runJson.run.id}/stop`, { method: "POST" });
});

test("POST /api/run accepts null fixturePath without 400 error", async () => {
  // Regression: fixturePath null was rejected by validation that only allowed string|undefined
  const response = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "test-null-fixture",
      background: "test",
      fixturePath: null,
      outputDir: "runs/ui-test-null-fixture",
      threadId: "test-null-fixture",
      noInterrupt: true,
      ragEnabled: false,
    }),
  });
  assert.equal(response.status, 202);
  const data = await response.json();
  assert.ok(data.run.id);
  // 清理
  await fetch(`${base}/api/runs/${data.run.id}/stop`, { method: "POST" });
});

test("POST /api/runs/:id/recover 从失败任务的 checkpoint 恢复", async () => {
  const outputDir = `runs/ui-test-recover-${Date.now()}`;
  const response = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "recover-test",
      background: "recover-test",
      fixturePath: "tests/fixtures/does-not-exist.json",
      outputDir,
      threadId: "recover-test",
      noInterrupt: true,
      ragEnabled: false,
    }),
  });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  const failedRun = await waitForRunStatus(run.id, "failed");
  assert.equal(failedRun.recoverable, true);

  const absoluteOut = resolve(projectRoot, outputDir);
  await mkdir(absoluteOut, { recursive: true });
  await writeFile(resolve(absoluteOut, "checkpoints.sqlite"), "checkpoint");

  const recoverResponse = await fetch(`${base}/api/runs/${run.id}/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(recoverResponse.status, 200);
  const recovered = (await recoverResponse.json()).run;
  assert.equal(recovered.status, "running");
  assert.equal(recovered.recoverable, false);
  assert.match(recovered.command, /supervise-recover/);
});

test("恢复达到安全上限后进入 blocked 且不能再次恢复", async () => {
  const outputDir = `runs/ui-test-recover-blocked-${Date.now()}`;
  const response = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "recover-blocked-test",
      background: "recover-blocked-test",
      outputDir,
      threadId: "recover-blocked-test",
      noInterrupt: true,
      ragEnabled: false,
    }),
  });
  const { run } = await response.json();
  const failedRun = await waitForRunStatus(run.id, "failed");
  assert.equal(failedRun.recoverable, true);

  const firstRecover = await fetch(`${base}/api/runs/${run.id}/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(firstRecover.status, 200);

  const blockedRun = await waitForRunStatus(run.id, "blocked");
  assert.equal(blockedRun.recoverable, false);
  const secondRecover = await fetch(`${base}/api/runs/${run.id}/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(secondRecover.status, 409);
});

test("GET /api/env/check 返回环境检测结果", async () => {
  const response = await fetch(`${base}/api/env/check`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.python);
  assert.ok(data.node);
  assert.ok(data.uv);
  assert.equal(typeof data.allOk, "boolean");
});

test("GET /api/onboarding/status 返回引导状态", async () => {
  const response = await fetch(`${base}/api/onboarding/status`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(["no_env", "no_api_key", "done"].includes(data.reason));
  assert.equal(typeof data.needed, "boolean");
});

test("GET /api/config 返回配置（密钥掩码）", async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.apiBase !== undefined);
  assert.ok(data.defaultModel !== undefined);
  assert.ok(data.strongModel !== undefined);
  // apiKey 不应包含明文（如果存在的话应被掩码）
  if (data.apiKey) {
    assert.ok(data.apiKey.includes("***") || data.apiKey.length === 0);
  }
});

test("GET /api/health 包含 onboarding 字段", async () => {
  const response = await fetch(`${base}/api/health`);
  const data = await response.json();
  assert.ok(data.onboarding);
  assert.ok(["no_env", "no_api_key", "done"].includes(data.onboarding.reason));
});

test("POST /api/config/test-llm 拒绝缺少参数的请求", async () => {
  const response = await fetch(`${base}/api/config/test-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiBase: "https://example.com/v1" }),
  });
  assert.equal(response.status, 400);
});

test("POST /api/config/test-llm 向直连端点发送原生模型名", async (context) => {
  const receivedModels = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    receivedModels.push(JSON.parse(body).model);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }));
  });
  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise((resolveClose) => upstream.close(resolveClose)));

  const upstreamPort = upstream.address().port;
  const apiBase = `http://127.0.0.1:${upstreamPort}/v1`;
  for (const model of ["openai/deepseek-chat", "ollama/llama3", "ocg/custom-model"]) {
    const response = await fetch(`${base}/api/config/test-llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiBase, apiKey: "test-key", model }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
  }

  assert.deepEqual(receivedModels, ["deepseek-chat", "llama3", "ocg/custom-model"]);
});

test("GET /api/providers 返回提供商列表", async () => {
  const response = await fetch(`${base}/api/providers`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length >= 5);
  assert.ok(data.some((p) => p.id === "deepseek"));
});
