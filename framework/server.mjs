import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAgentPackage, repairAgentPackage, reflectAgentPackage, supervisePackage } from "./llm.mjs";

const frameworkRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(frameworkRoot, "..");
const dataRoot = resolve(process.env.FRAMEWORK_DATA_DIR || resolve(projectRoot, "runs", "framework"));
const statePath = resolve(dataRoot, "state.json");
const eventPath = resolve(dataRoot, "events.jsonl");
const configPath = resolve(dataRoot, "config.json");
const port = Number.parseInt(process.env.FRAMEWORK_PORT || "5174", 10);
const clients = new Set();
let reviewInFlight = false;
let retryInFlight = false;
let activeChild = null;
let activeRunToken = 0;
const MAX_EXECUTION_MS = 120_000;
const MAX_EXECUTION_OUTPUT_BYTES = 2 * 1024 * 1024;

const STAGES = [
  { key: "problem_intake", label: "题目接收", role: "接收者", agent: "problem-intake", brief: "读取已确认的题目文件和数据清单，固定输入哈希。" },
  { key: "problem_alignment", label: "问题对齐", role: "决策者", agent: "decision-maker", brief: "把人类目标、宪法和题目转为可验收的 Problem Charter。" },
  { key: "proposal_baseline", label: "基线提议", role: "提议者", agent: "proposer", brief: "提出可解释、可复现的稳健基线方案。" },
  { key: "proposal_improved", label: "改进提议", role: "提议者", agent: "proposer", brief: "提出相对基线有明确改进目标的方案。" },
  { key: "proposal_innovative", label: "创新提议", role: "提议者", agent: "proposer", brief: "提出创新路线，同时声明假设、风险和验证计划。" },
  { key: "proposal_supervisor", label: "提案监督", role: "Agent Supervisor", agent: "supervisor", brief: "独立检查三类提案是否可比较、可验证且符合宪法。" },
  { key: "decision_maker", label: "路线决策", role: "决策者", agent: "decision-maker", brief: "依据已批准提案选择执行路线和不可放宽的验收条件。" },
  { key: "task_package_supervisor", label: "任务包监督", role: "Agent Supervisor", agent: "supervisor", brief: "检查任务、输入、工具、输出和失败处理是否完整。" },
  { key: "execution_planner", label: "执行规划", role: "执行规划者", agent: "execution-planner", brief: "把任务包拆成可执行实验、依赖和复现命令。" },
  { key: "python_executor", label: "Python 执行", role: "执行者", agent: "python-executor", brief: "运行 Python 基线或优化实验并保留 stdout/stderr。" },
  { key: "matlab_executor", label: "MATLAB 执行", role: "执行者", agent: "matlab-executor", brief: "登记 MATLAB 路线；无 MATLAB 时必须明确记录未执行。" },
  { key: "comsol_executor", label: "COMSOL 执行", role: "执行者", agent: "comsol-executor", brief: "登记 COMSOL 路线；无 COMSOL 时必须明确记录未执行。" },
  { key: "math_verifier", label: "数学核验", role: "核验者", agent: "math-verifier", brief: "核对公式、变量、边界条件和数值结果之间的一致性。" },
  { key: "execution_aggregator", label: "结果汇总", role: "汇总者", agent: "execution-aggregator", brief: "只聚合已批准执行证据，形成结果表和数据血缘。" },
  { key: "result_supervisor", label: "结果监督", role: "Agent Supervisor", agent: "supervisor", brief: "检查结果来源、哈希、失败日志和可复现性。" },
  { key: "paper_writer", label: "论文写作", role: "写作者", agent: "paper-writer", brief: "只读取 approved 证据生成论文草稿，不补写未执行数字。" },
  { key: "paper_integrity_reviewer", label: "论文完整性审查", role: "审查者", agent: "integrity-reviewer", brief: "核对每个结论是否能追溯到题目、代码和结果。" },
  { key: "reproducibility_reviewer", label: "复现审查", role: "审查者", agent: "reproducibility-reviewer", brief: "重放关键命令并检查依赖、随机种子和输入版本。" },
  { key: "paper_supervisor", label: "论文监督", role: "Agent Supervisor", agent: "supervisor", brief: "检查论文是否满足宪法、竞赛格式和证据门禁。" },
  { key: "latex_compiler", label: "排版编译", role: "编译者", agent: "latex-compiler", brief: "生成最终排版产物；编译失败必须保留日志并阻断交付。" },
  { key: "finalizer", label: "最终交付", role: "终结器", agent: "finalizer", brief: "检查交接链、证据哈希和全部审批记录，冻结交付包。" },
];

const REQUIRED_FILES = [
  "result_code.py",
  "result_document.md",
  "result_issues.md",
  "result_improvement_direction.md",
];

const INPUT_EXTENSIONS = new Set([".pdf", ".docx", ".md", ".txt", ".json", ".csv", ".xlsx", ".xls", ".py", ".cpp", ".c", ".h", ".hpp", ".html", ".css", ".js", ".tex", ".m", ".mph"]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACT_PREVIEW_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".c", ".cpp", ".css", ".csv", ".h", ".hpp", ".html", ".js", ".json", ".log", ".m", ".md", ".py", ".ps1", ".r", ".sh", ".tex", ".txt", ".xml", ".yaml", ".yml"]);

const DEFAULT_CONFIG = {
  mode: "demo",
  apiBase: "https://api.apikey.fun/v1",
  model: "",
  apiKey: "",
  temperature: 0,
};

const initialState = () => ({
  runId: null,
  status: "idle",
  stageIndex: -1,
  currentStage: null,
  package: null,
  constitution: {
    id: "constitution-demo",
    version: "v1.0",
    sha256: "",
    status: "locked",
    rules: [
      "不得伪造未执行的结果",
      "不得删除失败日志和历史版本",
      "每次交接必须经过 Agent Supervisor 和两次单人类审核",
      "不得自动降低数据真实性、关键公式正确性和核心验收条件",
    ],
  },
  problem: {
    title: "五个配送点的短路径分配",
    question: "给定仓库到五个配送点的距离和订单量，比较按距离优先与按订单量均衡的两种分配策略，计算总运输距离和平均装载率，并说明选择依据。",
    data: "距离 km：[2, 4, 7, 9, 12]；订单量：[8, 5, 12, 4, 9]；车辆容量：20 件。",
    rows: [],
    files: [],
  },
  project: null,
  history: [],
  humanReviews: [],
  revisionRequests: [],
  events: [],
  lastError: null,
});

async function ensureDataRoot() {
  await mkdir(dataRoot, { recursive: true });
}

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

let state = await loadJson(statePath, initialState());
let config = await loadJson(configPath, DEFAULT_CONFIG);
state.revisionRequests ||= [];
state.events ||= [];
state.history ||= [];
state.humanReviews ||= [];

async function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameWithRetry(tmp, path);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

// Windows can briefly hold a directory/file handle after a read or antivirus scan.
// Retrying the same atomic operation keeps the usual atomic path while avoiding a
// false failure caused by a transient EPERM/EBUSY.
async function renameWithRetry(source, target, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!(["EPERM", "EBUSY", "EACCES"].includes(error.code)) || attempt === attempts - 1) throw error;
      await delay(50 * (attempt + 1));
    }
  }
  throw lastError;
}

async function persist() {
  await atomicJson(statePath, state);
}

function safePath(input) {
  const target = resolve(projectRoot, input || ".");
  const rel = relative(projectRoot, target);
  const dataRel = relative(dataRoot, target);
  const insideProject = rel !== ".." && !rel.startsWith(`..${sep}`);
  const insideData = dataRel !== ".." && !dataRel.startsWith(`..${sep}`);
  if (!insideProject && !insideData) {
    throw new HttpError(403, "路径超出项目目录。");
  }
  return target;
}

function isWithin(child, parent) {
  const childPath = resolve(child);
  const parentPath = resolve(parent);
  const rel = relative(parentPath, childPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../"));
}

function dataPath(input) {
  const target = safePath(input);
  if (!isWithin(target, dataRoot)) throw new HttpError(403, "只允许访问运行数据目录中的文件。");
  return target;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function publicConfig() {
  return { ...config, apiKey: config.apiKey ? `${config.apiKey.slice(0, 4)}***${config.apiKey.slice(-4)}` : "" };
}

function publicState() {
  return {
    ...state,
    stages: STAGES.map((stage, index) => ({
      ...stage,
      technicalId: `stage-${String(index + 1).padStart(2, "0")}-${stage.key}`,
      displayId: `蓝图1-${stage.label}`,
    })),
    config: publicConfig(),
    package: state.package ? {
      ...state.package,
      technicalId: state.package.technicalId || `package-${state.package.packageId}`,
      displayId: state.package.displayId || `${state.currentStage?.label || state.package.stageKey} · attempt ${state.package.attempt}`,
      parentTechnicalId: state.package.parentTechnicalId || null,
      files: state.package.files || [],
    } : null,
  };
}

function publicProject() {
  return state.project ? { ...state.project, files: state.project.files || [] } : null;
}

async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

// The model may inspect this record, but it can never author it.  It is the
// framework's source of truth for input integrity; a model-written hash in
// result_code.py is only a claim and must not replace this verification.
async function verifyAuthoritativeInputs() {
  const inputFiles = state.problem?.files || [];
  const records = [];
  for (const file of inputFiles) {
    const filename = cleanRelativeName(file.filename);
    const target = resolve(dataRoot, state.runId || "", "inputs", filename);
    const exists = existsSync(target);
    const actual = exists ? await sha256File(target) : null;
    const expected = String(file.sha256 || "").toLowerCase();
    records.push({ filename, exists, expected_sha256: expected || null, actual_sha256: actual, hash_match: Boolean(exists && isSha256(expected) && actual === expected) });
  }
  return {
    verifier: "framework-authoritative-input-verifier-v1",
    algorithm: "sha256",
    ok: records.every((record) => record.hash_match) && records.length === inputFiles.length,
    records,
  };
}

async function writeAuthoritativeInputVerification(dir) {
  const verification = await verifyAuthoritativeInputs();
  await atomicJson(resolve(dir, "input_integrity.json"), verification);
  return verification;
}

function parseJsonLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

function validateExecutionEvidence(value) {
  const structured = parseJsonLines(value.stdout);
  const failedChecks = structured.flatMap((item) => {
    const failures = [];
    if (item.input_hash_check_passed === false) failures.push("input_hash_check_passed=false");
    if (item.hash_check_passed === false) failures.push("hash_check_passed=false");
    if (item.integrity_check_passed === false) failures.push("integrity_check_passed=false");
    return failures;
  });
  if (!failedChecks.length) return value;
  return {
    ...value,
    ok: false,
    businessEvidenceFailure: failedChecks,
    stderr: `${value.stderr || ""}${value.stderr ? "\n" : ""}框架证据校验失败：${failedChecks.join(", ")}`,
  };
}

function artifactKind(name) {
  const extension = extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (extension === ".xlsx" || extension === ".xls") return "spreadsheet";
  if (extension === ".pdf") return "pdf";
  if (extension === ".mph") return "comsol_model";
  return "binary";
}

function isPreviewableArtifact(name) {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

async function listRelativeFiles(dir) {
  const result = [];
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath, relativeName);
      else if (entry.isFile()) result.push(relativeName.replaceAll("\\", "/"));
    }
  }
  await visit(dir);
  return result;
}

async function copyDirectoryContents(source, target, files = null) {
  for (const file of files || await listRelativeFiles(source)) {
    const destination = resolve(target, file);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, await readFile(resolve(source, file)));
  }
}

async function describePackageFiles(dir) {
  const names = await listRelativeFiles(dir);
  const priority = new Map([...REQUIRED_FILES, "reasoning_trace.json", "manifest.json", "supervisor_verdict.json", "stdout.txt", "stderr.txt", "execution_log.json"].map((name, index) => [name, index]));
  names.sort((a, b) => (priority.get(a) ?? 1000) - (priority.get(b) ?? 1000) || a.localeCompare(b));
  return Promise.all(names.map(async (name) => {
    const filePath = resolve(dir, name);
    const info = await stat(filePath);
    return {
      name: name.split("/").at(-1),
      path: name,
      extension: extname(name).toLowerCase(),
      kind: artifactKind(name),
      previewable: isPreviewableArtifact(name),
      size: info.size,
      sha256: await sha256File(filePath),
    };
  }));
}

function cleanRelativeName(name) {
  const parts = String(name || "input").replaceAll("\\", "/").split("/").filter((part) => part && part !== "." && part !== "..");
  const cleaned = parts.map((part) => cleanName(part)).filter(Boolean);
  return cleaned.join("/") || "input";
}

function packageRelativeName(name) {
  const cleaned = cleanRelativeName(name);
  if (!cleaned || cleaned.startsWith(".") || cleaned.split("/").some((part) => part === "manifest.json" || part === "supervisor_verdict.json")) throw new HttpError(400, "Agent 产物路径无效或覆盖了系统文件。");
  return cleaned;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

async function appendEvent(type, payload = {}) {
  const sequence = (state.events.at(-1)?.sequence || 0) + 1;
  const stage = payload.stageKey ? STAGES.find((item) => item.key === payload.stageKey) : (state.currentStage || STAGES[state.stageIndex]);
  const packageId = payload.packageId || state.package?.packageId || null;
  const displayTitle = payload.displayTitle || `${stage?.label || "工作流"}${packageId ? ` · ${packageId}` : ""}`;
  const displayMessage = payload.displayMessage || payload.message || naturalEventMessage(type, payload, stage);
  const event = {
    sequence,
    time: new Date().toISOString(),
    runId: state.runId,
    stage: stage?.key || null,
    stageLabel: stage?.label || null,
    technicalId: packageId,
    displayId: packageId ? `${stage?.label || "节点"}·${packageId}` : null,
    displayTitle,
    displayMessage,
    type,
    ...payload,
  };
  state.events = [...state.events.slice(-499), event];
  await appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  const message = `id: ${sequence}\nevent: framework\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) {
    try { response.write(message); } catch { clients.delete(response); }
  }
  return event;
}

function naturalEventMessage(type, payload, stage) {
  if (type === "human_review_required") return payload.gate === "evidence" ? "等待唯一人类第二审：检查证据、复现和放行范围。" : "等待唯一人类第一审：检查内容、目标和宪法。";
  if (type === "human_review") return `${payload.reviewer || "唯一人类"}已提交${payload.gate === "content" ? "第一审" : "第二审"}：${payload.decision || "未指定"}。`;
  if (type === "supervisor_verdict") return `Agent Supervisor 已完成${stage?.label || "当前节点"}审查：${payload.decision || "未知"}。`;
  if (type === "package_promoted") return "文件包已完成哈希复核并原子晋级，下一 Agent 只能读取已批准副本。";
  if (type === "run_completed") return "所有节点均完成 Supervisor 和唯一人类双重审核，最终包已冻结。";
  if (type === "human_control") return `唯一人类执行了运行控制：${payload.action || "未知"}。`;
  if (type === "input_uploaded") return `已登记 ${payload.files?.length || 0} 个输入文件并计算 SHA-256。`;
  return stage ? `${stage.label}：工作流事件 ${type}。` : `工作流事件：${type}。`;
}

async function writeText(path, content) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

// Agent receives a bounded, read-only snapshot of the current workspace. This is
// the factual substrate for its decisions; a manifest-only prompt made the old
// live mode look intelligent while leaving the model blind to the actual files.
async function workspaceSnapshot(dir) {
  const names = await listRelativeFiles(dir);
  const snapshot = [];
  let budget = 60_000;
  for (const name of names) {
    const filePath = resolve(dir, name);
    const info = await stat(filePath);
    const item = { path: name, size: info.size, sha256: await sha256File(filePath), kind: artifactKind(name) };
    if (budget > 0 && isPreviewableArtifact(name) && info.size <= 512 * 1024) {
      const text = await readFile(filePath, "utf8");
      item.content = text.slice(0, Math.min(text.length, budget));
      item.truncated = text.length > item.content.length;
      budget -= item.content.length;
    } else {
      item.content = item.kind === "binary" ? "[二进制或专用格式：已登记哈希，需由本地工具解析]" : "[文件过大：仅提供哈希和大小]";
    }
    snapshot.push(item);
  }
  return snapshot;
}

const AGENT_RESERVED_FILES = new Set(["manifest.json", "supervisor_verdict.json", "stdout.txt", "stderr.txt", "execution_log.json", "reasoning_trace.json", "input_integrity.json"]);

async function writeAgentFiles(dir, generated, archivePrefix = "") {
  for (const file of generated.files || []) {
    const path = packageRelativeName(file.path);
    if (AGENT_RESERVED_FILES.has(path) || path.split("/").some((part) => AGENT_RESERVED_FILES.has(part))) {
      throw new Error(`Agent 不能写入系统证据文件：${path}`);
    }
    const target = resolve(dir, archivePrefix, path);
    if (!isWithin(target, dir)) throw new Error(`Agent 文件超出当前 staging：${path}`);
    await writeText(target, file.content);
  }
}

async function emitReasoningEvents(packageId, stage, reasoning, phase = "planning") {
  if (!reasoning) return;
  const fields = [
    ["observation", reasoning.observations], ["hypothesis", reasoning.hypotheses], ["alternative", reasoning.alternatives],
    ["decision_basis", reasoning.decision_basis], ["tool_plan", reasoning.tool_plan], ["check", reasoning.checks], ["uncertainty", reasoning.uncertainty],
  ];
  for (const [step, values] of fields) for (const value of values || []) {
    await appendEvent("agent_thinking", { packageId, agent: stage.agent, role: stage.role, phase, step, message: value });
  }
  if (reasoning.decision) await appendEvent("agent_decision", { packageId, agent: stage.agent, phase, decision: reasoning.decision, basis: reasoning.decision_basis || [] });
}

async function executePython(codePath, outputDir = null) {
  const venvPython = resolve(projectRoot, ".venv", "Scripts", "python.exe");
  const command = existsSync(venvPython) ? venvPython : (process.env.PYTHON || "python");
  const codeSha256 = await sha256File(codePath);
  const executionOutputDir = outputDir || (state.runId ? resolve(dataRoot, state.runId, "outputs") : resolve(dataRoot, "demo-outputs"));
  return new Promise((resolvePromise) => {
    const child = spawn(command, [codePath], { cwd: projectRoot, windowsHide: true, env: { ...process.env, FRAMEWORK_INPUT_DIR: state.runId ? resolve(dataRoot, state.runId, "inputs") : projectRoot, FRAMEWORK_OUTPUT_DIR: executionOutputDir, FRAMEWORK_PROJECT_ROOT: projectRoot, FRAMEWORK_INPUT_INTEGRITY_PATH: resolve(codePath, "..", "input_integrity.json") } });
    activeChild = child;
    let stdout = ""; let stderr = "";
    let settled = false;
    const appendOutput = (target, chunk) => {
      const remaining = MAX_EXECUTION_OUTPUT_BYTES - Buffer.byteLength(target, "utf8");
      return target + chunk.toString("utf8").slice(0, Math.max(0, remaining));
    };
    const finish = (result) => { if (!settled) { settled = true; activeChild = null; clearTimeout(timeout); resolvePromise({ ...result, codePath: relative(projectRoot, codePath).replaceAll("\\", "/"), codeSha256, outputDir: relative(projectRoot, executionOutputDir).replaceAll("\\", "/") }); } };
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, signal: "SIGTERM", timedOut: true, stdout, stderr: `${stderr}${stderr ? "\n" : ""}执行超过 ${MAX_EXECUTION_MS / 1000} 秒，已终止。` });
    }, MAX_EXECUTION_MS);
    child.on("error", (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.on("close", (code, signal) => finish({ ok: code === 0 && !signal, code, signal: signal || null, timedOut: false, stdout, stderr }));
  });
}

function demoCode(stage, attempt) {
  if (stage.key === "python_executor") {
    if (/烟幕干扰弹|投放策略/.test(state.problem.question || state.problem.title || "")) {
      return `import os\nimport subprocess\nimport sys\nfrom pathlib import Path\n\n# A 题学术建模执行器：读取本次已确认的输入目录，运行确定性运动学基线。\nsolver = Path(os.environ["FRAMEWORK_PROJECT_ROOT"]) / "framework" / "a_solver.py"\nresult = subprocess.run([sys.executable, str(solver)], cwd=solver.parent.parent, env=os.environ.copy(), text=True, capture_output=True)\nprint(result.stdout, end="")\nif result.stderr:\n    print(result.stderr, file=sys.stderr, end="")\nraise SystemExit(result.returncode)\n`;
    }
    const rows = state.problem.rows?.length ? state.problem.rows : [{ station: "demo", demand_morning: 18, initial_bikes: 10 }];
    return `from statistics import mean\n\nROWS = ${JSON.stringify(rows)}\n\n# 数据来自本次项目已确认的输入文件。\nrow_count = len(ROWS)\nnumber_fields = {}\nfor row in ROWS:\n    for key, value in row.items():\n        try:\n            number_fields.setdefault(key, []).append(float(value))\n        except (TypeError, ValueError):\n            pass\nif all(key in number_fields for key in ("demand_morning", "initial_bikes")):\n    demand = sum(number_fields["demand_morning"])\n    initial = sum(number_fields["initial_bikes"])\n    shortage_before = sum(max(d - b, 0) for d, b in zip(number_fields["demand_morning"], number_fields["initial_bikes"]))\n    shortage_after = max(shortage_before - max(initial - demand, 0), 0)\n    service_before = 1 - shortage_before / demand if demand else 1\n    print(f"total_demand={demand:.2f}")\n    print(f"shortage_before={shortage_before:.2f}")\n    print(f"shortage_after_greedy={shortage_after:.2f}")\n    print(f"service_rate_before={service_before:.4f}")\nelse:\n    print("numeric_columns=" + ",".join(sorted(number_fields)))\nprint(f"input_rows={row_count}")\nprint("seed=deterministic")\n`;
  }
  return `from pathlib import Path\nprint("stage=${stage.key}")\nprint("attempt=${attempt}")\nprint("evidence=generated-by-framework-demo")\nprint("input_files=${(state.problem.files || []).map((item) => item.filename).join(",") || "built-in-demo"}")\nprint(Path(__file__).name)\n`;
}

function reasoningTrace(stage, attempt, execution) {
  const hasCsv = (state.problem.files || []).some((file) => file.filename.toLowerCase().endsWith(".csv"));
  const isA = /烟幕干扰弹|投放策略/.test(state.problem.question || state.problem.title || "");
  const tools = stage.key === "python_executor" ? ["Python", "NumPy/标准库数值计算", "输入文件哈希清单"] : ["本地解析器", "已批准交接包", "Supervisor 校验器"];
  return {
    trace_version: "structured-reasoning-v1",
    node: stage.key,
    role: stage.role,
    agent: stage.agent,
    attempt,
    objective: stage.brief,
    approved_inputs: (state.problem.files || []).map((file) => ({ filename: file.filename, sha256: file.sha256 })),
    observations: [
      isA ? "检测到 2025 高教社杯数学建模 A 题文本，包含导弹、无人机、烟幕云团运动参数。" : `检测到题目：${state.problem.title}`,
      hasCsv ? "检测到一个或多个 CSV，后续按文件分别登记并合并记录。" : "未检测到 CSV；只使用题目文件中明确给出的参数。",
      "所有外部输入必须先经过人类确认，未确认内容不得进入正式结果。",
    ],
    hypotheses: [
      "模型只使用题目明确给出的运动学和几何假设。",
      "数值结果必须由执行器产生并保留 stdout/stderr。",
      "模板文件只作为格式输出，不被误当作实验输入。",
    ],
    tool_plan: tools,
    checks: [
      "输入文件名、大小和 SHA-256 已登记",
      "关键公式/参数在代码中可定位",
      "执行失败时保留失败日志，不自动降级为假结果",
      "Supervisor 复核四个结果文件、宪法版本和文件哈希",
    ],
    result: execution ? (execution.ok ? "执行完成，结果来自本次运行。" : "执行失败，禁止晋级。") : "节点产物已生成，等待人类审核。",
    uncertainty: "该节点结论仍需人类第一审和第二审；数值优化质量不能仅由流程通过替代。",
    next_action: "先由 Supervisor 检查，再由同一人类完成内容审和证据审。",
  };
}

function demoDocument(stage, attempt, execution) {
  const common = `# ${stage.label}结果\n\n- 责任 Agent：${stage.role}（${stage.agent}）\n- 运行模式：本地确定性演示\n- attempt：${attempt}\n- 议题：${state.problem.title}\n- 宪法：${state.constitution.version}\n\n`;
  const bodies = {
    alignment: "已将题目收敛为：比较两种配送分配策略，并用总运输距离、平均装载率和可解释性作为验收指标。禁止把未运行的数字写进论文。",
    proposal: "提出三个候选：A 近距离优先基线；B 订单量均衡改进；C 带容量约束的整数规划创新方案。本次小议题先执行 A/B，C 留作扩展。",
    task: "选定 A/B 对比任务。要求执行真实 Python 文件，输出总距离、装载率、输入行数和确定性标记；失败时必须保留 stdout/stderr。",
    python_executor: execution?.ok ? `实验成功。\n\n${execution.stdout.trim()}\n\n结果只来自本次运行的 stdout。A 题输出模板由确定性求解器生成，仍需人工复核模型假设和全局最优性。` : "实验未成功，结果不得晋级。",
    paper: "论文草稿只引用 approved execution 包中的数字，并明确这是小规模演示，不把代理距离解释成严格最优解。",
    final: "最终包检查通过：交接历史完整，所有阶段有 Supervisor 结论和两次人类审批，最终文件可由 approved 目录重放。",
  };
  return `${common}${bodies[stage.key] || `本节点完成：${stage.brief}\n\n本节点不自行批准结果，必须等待 Supervisor 和两次人类审核。`}\n`;
}

function demoIssues(stage, execution) {
  if (stage.key === "python_executor" && !execution?.ok) return "- 代码执行失败，必须先修复并重新执行。\n- 未生成可用结果，不得进入论文阶段。\n";
  const issues = {
    alignment: "- 真实竞赛题目尚未接入；本次仅验证流程。\n",
    proposal: "- 创新方案尚未实验验证。\n",
    task: "- 当前实验规模很小，不能代表真实竞赛数据。\n",
    python_executor: "- 当前实验是可复现基线，不代表大规模竞赛数据。\n",
    paper: "- 只生成一页草稿，尚未包含完整参考文献和 LaTeX 排版。\n",
    final: "- 该演示不产生正式竞赛 PDF。\n",
  };
  return issues[stage.key] || "- 无新增阻断问题，但仍需人类确认。\n";
}

function demoImprovement(stage) {
  const next = STAGES[STAGES.findIndex((item) => item.key === stage.key) + 1];
  return `# Supervisor 改进方向\n\n当前阶段：${stage.label}\nSupervisor 要求：\n\n- 保留本交接包及其哈希，不覆盖历史 attempt。\n- 下一步${next ? `进入“${next.label}”，重点是：${next.brief}` : "冻结最终交付包并复核全部审计记录"}。\n- 如果发现证据冲突，立即退回修订，不得降低宪法要求。\n`;
}

async function buildManifest(dir, stage, attempt, execution, packageId, metadata = {}) {
  const hashes = {};
  for (const file of REQUIRED_FILES) if (existsSync(resolve(dir, file))) hashes[file] = await sha256File(resolve(dir, file));
  const needsCompetitionOutputs = (state.problem.files || []).some((file) => file.kind === "output_template");
  const additionalFiles = stage.key === "finalizer" && needsCompetitionOutputs ? ["result1.xlsx", "result2.xlsx", "result3.xlsx", "solver_summary.json", "final_submission.md"].filter((file) => existsSync(resolve(dir, file))) : [];
  const additionalHashes = {};
  for (const file of additionalFiles) additionalHashes[file] = await sha256File(resolve(dir, file));
  const artifactFiles = await describePackageFiles(dir);
  const inputIntegrity = await loadJson(resolve(dir, "input_integrity.json"), null);
  return {
    package_id: packageId,
    stage: stage.key,
    attempt,
    required_files: REQUIRED_FILES,
    hashes,
    additional_files: additionalFiles,
    additional_hashes: additionalHashes,
    artifact_files: artifactFiles,
    input_integrity: inputIntegrity,
    execution: execution ? { ...execution, stdout: undefined, stderr: undefined } : null,
    constitution_version: state.constitution.version,
    input_files: state.problem.files || [],
    generation_status: metadata.generationStatus || "demo",
    agent_models: metadata.agentModels || [],
    tool_iterations: metadata.toolIterations || [],
    created_at: new Date().toISOString(),
  };
}

async function supervisorCheck(dir, stage, manifest) {
  const missing = [];
  for (const file of REQUIRED_FILES) {
    try { await stat(resolve(dir, file)); } catch { missing.push(file); }
  }
  const hashMismatches = [];
  if (!missing.length) {
    for (const file of REQUIRED_FILES) {
      if (manifest.hashes?.[file] !== await sha256File(resolve(dir, file))) hashMismatches.push(file);
    }
  }
  const needsCompetitionOutputs = (state.problem.files || []).some((file) => file.kind === "output_template");
  const requiredAdditional = stage.key === "finalizer" && needsCompetitionOutputs ? ["result1.xlsx", "result2.xlsx", "result3.xlsx", "solver_summary.json", "final_submission.md"] : [];
  const missingAdditional = requiredAdditional.filter((file) => !existsSync(resolve(dir, file)));
  for (const file of requiredAdditional.filter((item) => existsSync(resolve(dir, item)))) {
    if (manifest.additional_hashes?.[file] !== await sha256File(resolve(dir, file))) hashMismatches.push(file);
  }
  const missingArtifacts = [];
  for (const artifact of manifest.artifact_files || []) {
    try {
      await stat(resolve(dir, artifact.path));
      if (artifact.sha256 !== await sha256File(resolve(dir, artifact.path))) hashMismatches.push(artifact.path);
    } catch {
      missingArtifacts.push(artifact.path);
    }
  }
  const liveInputIntegrity = await verifyAuthoritativeInputs();
  const recordedInputIntegrity = manifest.input_integrity;
  const recordedInputIntegrityMatches = Boolean(
    recordedInputIntegrity &&
    recordedInputIntegrity.verifier === liveInputIntegrity.verifier &&
    recordedInputIntegrity.algorithm === liveInputIntegrity.algorithm &&
    recordedInputIntegrity.ok === liveInputIntegrity.ok &&
    JSON.stringify(recordedInputIntegrity.records || []) === JSON.stringify(liveInputIntegrity.records || []),
  );
  const inputIntegrityIssues = [];
  if (!liveInputIntegrity.ok) inputIntegrityIssues.push("运行输入的权威 SHA-256 校验未通过，输入文件可能被外部修改或清单已失真。");
  if (!recordedInputIntegrityMatches) inputIntegrityIssues.push("交接包缺少与当前运行输入一致的系统权威 input_integrity.json 记录。");
  // Demo mode historically permits its intentionally tiny/optional executor to
  // be inspected by the state-machine tests. Live mode marks failures as
  // generation_status=failed, so a real Agent failure can never pass this gate.
  const valid = missing.length === 0 && missingAdditional.length === 0 && missingArtifacts.length === 0 && hashMismatches.length === 0 && inputIntegrityIssues.length === 0 && manifest.constitution_version === state.constitution.version && manifest.generation_status !== "failed" && !(manifest.generation_status === "completed" && manifest.execution?.ok === false);
  return {
    decision: valid ? "submit_for_human_review" : "revise",
    constitutional_status: valid ? "pass" : "fail",
    technical_status: valid ? "feasible" : "infeasible",
    evidence_status: valid ? "complete" : "incomplete",
    reproducibility_status: stage.key === "python_executor" ? (manifest.execution?.ok ? "pass" : "fail") : "not_applicable",
    missing,
    blocking_issues: valid ? [] : ["交接文件不完整、哈希不一致、输入完整性不一致、最终输出缺失或宪法版本不一致", ...inputIntegrityIssues],
    required_repairs: valid ? [] : ["补齐文件、恢复原始内容并重新提交 Supervisor", ...inputIntegrityIssues],
    hash_mismatches: hashMismatches,
    missing_additional: missingAdditional,
    missing_artifacts: missingArtifacts,
    supervisor_version: "framework-supervisor-1",
  };
}

async function createPackage(stageIndex, attempt = 1) {
  const runToken = activeRunToken;
  const runId = state.runId;
  const stage = STAGES[stageIndex];
  const packageId = `${stage.key}-a${attempt}-${randomUUID().slice(0, 8)}`;
  const dir = resolve(dataRoot, state.runId, "staging", stage.key, packageId);
  await mkdir(dir, { recursive: true });
  state.stageIndex = stageIndex;
  const previous = state.history.at(-1);
  if (previous?.approvedDir) {
    const previousDir = safePath(previous.approvedDir);
    // Preserve the complete approved tree so provenance and multi-file outputs survive every handoff.
    const previousFiles = await listRelativeFiles(previousDir);
    await copyDirectoryContents(previousDir, resolve(dir, "incoming", previous.stageKey, previous.packageId), previousFiles);
  }
  if (stageIndex === 0) {
    const inputDir = resolve(dataRoot, state.runId, "inputs");
    if (existsSync(inputDir)) {
      const inputFiles = await listRelativeFiles(inputDir);
      await copyDirectoryContents(inputDir, resolve(dir, "incoming", "inputs"), inputFiles);
    }
  }
  // Write the framework-owned input evidence before the Agent sees the
  // snapshot. This gives every Agent and Supervisor the same authoritative
  // hashes and prevents model-authored constants from becoming the source of
  // truth.
  await writeAuthoritativeInputVerification(dir);
  await appendEvent("agent_started", { agent: stage.agent, role: stage.role, stageKey: stage.key, stageLabel: stage.label, packageId });
  let execution = null;
  let generationStatus = config.mode === "live" ? "failed" : "demo";
  let agentFailure = null;
  let generated = null;
  let reasoning = null;
  const agentModels = [];
  const toolIterations = [];
  const recordExecution = async (value, iteration) => {
    value = validateExecutionEvidence(value);
    const authoritativeInputIntegrity = await verifyAuthoritativeInputs();
    if (!authoritativeInputIntegrity.ok) {
      value = {
        ...value,
        ok: false,
        authoritativeInputIntegrity,
        stderr: `${value.stderr || ""}${value.stderr ? "\n" : ""}框架权威输入校验失败：运行期间输入文件与已冻结清单不一致。`,
      };
    } else {
      value = { ...value, authoritativeInputIntegrity: { verifier: authoritativeInputIntegrity.verifier, algorithm: authoritativeInputIntegrity.algorithm, ok: true } };
    }
    execution = value;
    toolIterations.push({ iteration, ok: value.ok, code: value.code, signal: value.signal || null, timedOut: Boolean(value.timedOut) });
    await writeText(resolve(dir, "stdout.txt"), value.stdout || "");
    await writeText(resolve(dir, "stderr.txt"), value.stderr || "");
    await writeText(resolve(dir, "execution_log.json"), `${JSON.stringify({ command: "python result_code.py", iteration, executed_code_path: value.codePath || "result_code.py", executed_code_sha256: value.codeSha256 || null, ...value, timestamp: new Date().toISOString() }, null, 2)}\n`);
    await appendEvent("agent_tool_result", { packageId, agent: stage.agent, tool: "python", iteration, ok: value.ok, code: value.code, message: value.ok ? "Python 执行完成，stdout 已保存。" : (value.businessEvidenceFailure ? `程序退出正常，但业务证据校验失败：${value.businessEvidenceFailure.join(", ")}` : (value.authoritativeInputIntegrity?.ok === false ? "框架权威输入哈希校验失败，已进入修复判断。" : "Python 执行失败，stderr 已保存并进入修复判断。")) });
  };
  const writeGeneratedPackage = async (value, phase) => {
    await writeAgentFiles(dir, value);
    await writeText(resolve(dir, "result_document.md"), value.document_markdown);
    await writeText(resolve(dir, "result_issues.md"), value.issues_markdown);
    await writeText(resolve(dir, "result_improvement_direction.md"), value.improvement_markdown);
    reasoning = value.reasoning;
    await atomicJson(resolve(dir, "reasoning_trace.json"), { ...reasoning, trace_version: "llm-structured-reasoning-v2", node: stage.key, agent: stage.agent, attempt, phase });
    await emitReasoningEvents(packageId, stage, reasoning, phase);
    if (value.llm?.model) agentModels.push({ phase, model: value.llm.model, usage: value.llm.usage || null });
    await appendEvent("llm_generation_completed", { packageId, phase, model: value.llm?.model || config.model, usage: value.llm?.usage || null });
  };
  const writeReflectedPackage = async (value) => {
    await writeText(resolve(dir, "result_document.md"), value.document_markdown);
    await writeText(resolve(dir, "result_issues.md"), value.issues_markdown);
    await writeText(resolve(dir, "result_improvement_direction.md"), value.improvement_markdown);
    reasoning = value.reasoning;
    await atomicJson(resolve(dir, "reasoning_trace.json"), { ...reasoning, trace_version: "llm-structured-reasoning-v2", node: stage.key, agent: stage.agent, attempt, phase: "reflection" });
    await emitReasoningEvents(packageId, stage, reasoning, "reflection");
    if (value.llm?.model) agentModels.push({ phase: "reflection", model: value.llm.model, usage: value.llm.usage || null });
    await appendEvent("llm_generation_completed", { packageId, phase: "reflection", model: value.llm?.model || config.model, usage: value.llm?.usage || null });
  };

  if (config.mode === "live") {
    const baseContext = { stage, problem: state.problem, constitution: state.constitution, history: state.history, revision_requests: state.revisionRequests.filter((item) => item.stageKey === stage.key), workspace_snapshot: await workspaceSnapshot(dir) };
    try {
      // Planning is the Agent's first genuine decision: it selects the method and
      // writes the executable/tool files instead of receiving demoCode().
      generated = await generateAgentPackage(config, baseContext);
      await writeGeneratedPackage(generated, "planning");
      await recordExecution(await executePython(resolve(dir, "result_code.py"), dir), 1);
      if (!execution.ok) {
        await writeAgentFiles(dir, generated, "agent_outputs/tool_runs/iteration-1");
        await appendEvent("agent_repair_requested", { packageId, agent: stage.agent, reason: "工具执行失败；将把真实 stderr 交回 Agent 修复。" });
        const repaired = await repairAgentPackage(config, { ...baseContext, execution, generated_files: generated.files });
        generated = repaired;
        await writeGeneratedPackage(repaired, "repair");
        await recordExecution(await executePython(resolve(dir, "result_code.py"), dir), 2);
      }
      if (!execution.ok) {
        agentFailure = new Error("Agent 修复后 Python 仍未成功，禁止把失败包提交给人类审批。");
        await appendEvent("agent_blocked", { packageId, agent: stage.agent, message: agentFailure.message });
      } else {
        // Reflection is grounded in the tool result. It may revise prose and
        // reasoning, but cannot replace any already executed/generated file
        // silently. A file change must go through another repair + tool run.
        const reflected = await reflectAgentPackage(config, { ...baseContext, execution, generated_files: generated.files });
        // Reflection has a document-only contract. Code/data/tool artifacts
        // remain byte-for-byte identical to the files that produced evidence.
        await writeReflectedPackage(reflected);
        generationStatus = "completed";
      }
    } catch (error) {
      agentFailure = error;
      await writeText(resolve(dir, "result_document.md"), `# Agent 阻断记录\n\n真实 Agent 未能形成可验证交接包：${error.message}\n`);
      await writeText(resolve(dir, "result_issues.md"), `# 阻断\n\n${error.message}\n\n未使用演示代码替代；需修复模型调用、文件生成或工具执行后重新提交。\n`);
      await writeText(resolve(dir, "result_improvement_direction.md"), "# 修复方向\n\n修复 Agent 生成或工具执行失败，保留当前 staging 和日志后重新尝试。\n");
      await atomicJson(resolve(dir, "reasoning_trace.json"), { trace_version: "llm-blocked-v1", node: stage.key, agent: stage.agent, attempt, result: "blocked", error: error.message, next_action: "修复失败原因后重新提交" });
      await appendEvent("llm_generation_failed", { packageId, message: error.message });
    }
  } else {
    // Demo mode remains deterministic solely for testing the state machine. It
    // is intentionally isolated so it cannot be mistaken for live reasoning.
    const codePath = resolve(dir, "result_code.py");
    await writeText(codePath, demoCode(stage, attempt));
    await recordExecution(await executePython(codePath, dir), 1);
    await writeText(resolve(dir, "result_document.md"), demoDocument(stage, attempt, execution));
    await writeText(resolve(dir, "result_issues.md"), demoIssues(stage, execution));
    await writeText(resolve(dir, "result_improvement_direction.md"), demoImprovement(stage));
    await mkdir(resolve(dir, "agent_outputs"), { recursive: true });
    await writeText(resolve(dir, "agent_outputs", "README.md"), `# ${stage.label} Agent 输出目录\n\n本目录可包含任意数量和类型的 Agent 产物。演示模式不调用模型；正式模式会由 Agent 决定这些文件。\n`);
    if (stage.key === "python_executor" && /烟幕干扰弹|投放策略/.test(state.problem.question || state.problem.title || "")) {
      await writeFile(resolve(dir, "agent_outputs", "a_solver.py"), await readFile(resolve(frameworkRoot, "a_solver.py")));
      await writeText(resolve(dir, "agent_outputs", "model_check.cpp"), `#include <iostream>\nint main() { std::cout << "A-problem package verification" << std::endl; return 0; }\n`);
      await writeText(resolve(dir, "agent_outputs", "result_report.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>A 题阶段结果</title><body><main><h1>${htmlEscape(state.problem.title)}</h1><p>本报告由 Python 执行节点产生，数值证据以 stdout、solver_summary.json 和 Excel 输出为准。</p><p>该结果是学术建模基线，需要人类复核，不代表全局最优。</p></main></body></html>\n`);
    }
    reasoning = reasoningTrace(stage, attempt, execution);
    await atomicJson(resolve(dir, "reasoning_trace.json"), reasoning);
    for (const item of ["观察输入", "形成假设", "选择工具", "执行检查", "生成结论"]) await appendEvent("agent_thinking", { packageId, agent: stage.agent, step: item, message: `${stage.label}：${item}` });
  }
  if (!execution) await recordExecution({ ok: false, code: null, signal: null, timedOut: false, stdout: "", stderr: agentFailure?.message || "Agent 未产生可执行代码。" }, 0);
  if (agentFailure && config.mode === "live") generationStatus = "failed";
  if (stage.key === "finalizer") {
    for (const file of ["result1.xlsx", "result2.xlsx", "result3.xlsx", "solver_summary.json"]) {
      const outputPath = resolve(dataRoot, state.runId, "outputs", file);
      if (existsSync(outputPath)) await writeFile(resolve(dir, file), await readFile(outputPath));
    }
    if (!existsSync(resolve(dir, "final_submission.md"))) {
      await writeText(resolve(dir, "final_submission.md"), `# ${state.problem.title}最终交付索引\n\n- 本文件是系统生成的交付索引，不是未经执行的结果。\n- 数值结果必须追溯到本运行的 Python 执行器、outputs 目录和执行日志。\n- 必须结合 reasoning_trace.json、manifest.json、Supervisor 结论和两次人工审核记录复核。\n`);
    }
  }
  const manifest = await buildManifest(dir, stage, attempt, execution, packageId, { generationStatus, agentModels, toolIterations });
  await atomicJson(resolve(dir, "manifest.json"), manifest);
  let verdict = await supervisorCheck(dir, stage, manifest);
  if (config.mode === "live") {
    try {
      const liveVerdict = await supervisePackage(config, { stage, manifest, execution, constitution: state.constitution, input_files: state.problem.files, required_files: REQUIRED_FILES, artifact_files: manifest.artifact_files, package_snapshot: await workspaceSnapshot(dir), stage_scope: "只审当前节点的完整文件交接包；不得以未来节点或最终输出尚未生成作为当前节点阻断理由。" });
      const structurallyValid = verdict.decision === "submit_for_human_review";
      verdict = { ...verdict, ...liveVerdict, decision: structurallyValid && liveVerdict.decision === "submit_for_human_review" && !agentFailure ? "submit_for_human_review" : "revise" };
      if (!structurallyValid) verdict.blocking_issues = [...new Set([...(verdict.blocking_issues || []), ...(liveVerdict.blocking_issues || [])])];
    } catch (error) {
      verdict = { ...verdict, decision: "revise", constitutional_status: "fail", technical_status: "infeasible", evidence_status: "incomplete", blocking_issues: [`真实 Supervisor 调用失败：${error.message}`], required_repairs: ["修复模型端点或密钥后重新提交"] };
    }
  }
  await atomicJson(resolve(dir, "supervisor_verdict.json"), verdict);
  if (runToken !== activeRunToken || runId !== state.runId) {
    await appendEvent("stale_agent_result_discarded", { stageKey: stage.key, packageId, message: "该 Agent 属于已终止或已替换的运行，只保留 staging 日志，不写入当前运行状态。" });
    return;
  }
  const packageFiles = await describePackageFiles(dir);
  const parent = state.history.at(-1);
  state.package = {
    packageId,
    technicalId: `package-${packageId}`,
    displayId: `${stage.label} · attempt ${attempt}`,
    parentTechnicalId: parent?.packageId ? `package-${parent.packageId}` : null,
    stageKey: stage.key,
    stageIndex,
    attempt,
    dir: relative(projectRoot, dir).replaceAll("\\", "/"),
    files: packageFiles.map((file) => ({ ...file, technicalId: `package-${packageId}::${file.path}`, displayName: file.name })),
  };
  state.package.supervisor = verdict;
  state.package.execution = { ok: execution.ok, code: execution.code };
  state.status = verdict.decision === "submit_for_human_review" ? "waiting_human_review_1" : "blocked";
  state.currentStage = stage;
  await appendEvent("supervisor_verdict", { stageKey: stage.key, packageId, decision: verdict.decision, constitutionalStatus: verdict.constitutional_status, evidenceStatus: verdict.evidence_status });
  if (verdict.decision === "submit_for_human_review") {
    await appendEvent("human_review_required", { gate: "content", packageId, message: "等待人类第一审：内容、目标和宪法" });
  }
  await persist();
}

async function startDemo() {
  if (state.runId && !["completed", "aborted", "blocked", "idle"].includes(state.status)) {
    throw new HttpError(409, "已有运行处于活动状态，请先完成、暂停或终止当前运行。");
  }
  state = initialState();
  activeRunToken += 1;
  state.runId = `demo-${Date.now()}`;
  const runDir = resolve(dataRoot, state.runId);
  await mkdir(runDir, { recursive: true });
  const constitutionText = `# Constitution ${state.constitution.version}\n\n${state.constitution.rules.map((rule) => `- ${rule}`).join("\n")}\n`;
  state.constitution.sha256 = createHash("sha256").update(constitutionText).digest("hex");
  await writeText(resolve(runDir, "constitution.md"), constitutionText);
  await writeText(resolve(runDir, "problem.md"), `# ${state.problem.title}\n\n${state.problem.question}\n\n数据：${state.problem.data}\n`);
  await appendEvent("run_started", { mode: "demo", topic: state.problem.title });
  await createPackage(0, 1);
  return publicState();
}

function cleanName(name) {
  const cleaned = String(name || "input").replaceAll("\\", "/").split("/").at(-1).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, "_");
  return cleaned || "input";
}

function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((value, index) => value || `column_${index + 1}`);
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => {
    const value = values[index] ?? "";
    return [header, Number.isFinite(Number(value)) && value !== "" ? Number(value) : value];
  })));
}

async function readUploadBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "单次上传不能超过 20 MB。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^\"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new HttpError(400, "上传请求缺少 multipart boundary。");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    const start = cursor + boundary.length;
    const next = buffer.indexOf(boundary, start);
    if (next < 0) break;
    const part = buffer.subarray(start, next);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString("utf8");
      const content = part.subarray(headerEnd + 4, part.length - 2);
      const disposition = /Content-Disposition:[^\r\n]*?name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
      if (disposition) parts.push({ name: disposition[1], filename: disposition[2], content });
    }
    cursor = next;
  }
  return parts;
}

async function createProject(body) {
  if (state.runId && !["completed", "aborted", "blocked", "idle"].includes(state.status)) throw new HttpError(409, "已有运行处于活动状态，请先完成或终止当前运行。");
  state = initialState();
  const projectId = `project-${Date.now()}-${randomUUID().slice(0, 6)}`;
  state.project = { id: projectId, title: String(body.title || "未命名数学建模项目"), files: [], confirmed: false, createdAt: new Date().toISOString() };
  await mkdir(resolve(dataRoot, "projects", projectId), { recursive: true });
  await persist();
  return { project: publicProject(), state: publicState() };
}

async function uploadProjectFiles(request) {
  if (!state.project) throw new HttpError(409, "请先创建项目。");
  if (state.project.confirmed) throw new HttpError(409, "题目与数据已经确认；如需修改，请新建项目并重新确认输入。");
  const parts = parseMultipart(await readUploadBody(request), request.headers["content-type"]);
  const files = parts.filter((part) => part.filename);
  if (!files.length) throw new HttpError(400, "没有检测到文件字段。");
  const stored = [];
  const existingNames = new Set((state.project.files || []).map((file) => file.filename));
  const incomingNames = new Set();
  for (const part of files) {
    const filename = cleanRelativeName(part.filename);
    const leafName = filename.split("/").at(-1);
    const extension = extname(leafName).toLowerCase();
    if (!INPUT_EXTENSIONS.has(extension)) throw new HttpError(415, `不支持的文件类型：${extension || "无扩展名"}`);
    if (existingNames.has(filename) || incomingNames.has(filename)) throw new HttpError(409, `文件名重复，拒绝覆盖：${filename}`);
    incomingNames.add(filename);
    const target = resolve(dataRoot, "projects", state.project.id, filename);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, part.content);
    const digest = createHash("sha256").update(part.content).digest("hex");
    const kind = /^(result[123])\.xlsx$/i.test(leafName) ? "output_template" : /\.(csv)$/i.test(leafName) ? "dataset" : /\.(pdf|docx|md|txt|json)$/i.test(leafName) ? "problem" : "attachment";
    const metadata = { filename, kind, size: part.content.length, sha256: digest, mimeType: "application/octet-stream", storedPath: relative(projectRoot, target).replaceAll("\\", "/"), excerpt: extension === ".csv" || extension === ".md" || extension === ".txt" || extension === ".json" ? part.content.toString("utf8").slice(0, 1600) : "二进制文件，已保存并计算哈希" };
    state.project.files = [...state.project.files, metadata];
    stored.push(metadata);
  }
  await appendEvent("input_uploaded", { projectId: state.project.id, files: stored.map((file) => file.filename) });
  await persist();
  return { project: publicProject(), files: stored };
}

async function confirmProject(projectId, body = {}) {
  if (!state.project || state.project.id !== projectId) throw new HttpError(404, "项目不存在。");
  const files = state.project.files || [];
  const problemFiles = files.filter((file) => file.kind === "problem");
  const problemFile = problemFiles.find((file) => /\.(txt|md|json)$/i.test(file.filename.split("/").at(-1))) || problemFiles.find((file) => /\.(pdf|docx)$/i.test(file.filename.split("/").at(-1)));
  const dataFiles = files.filter((file) => file.kind === "dataset");
  const templates = files.filter((file) => file.kind === "output_template");
  if (!problemFile) throw new HttpError(400, "请上传题目文件（PDF、DOCX、MD、TXT 或 JSON）。");
  if (!dataFiles.length && !templates.length) throw new HttpError(400, "请上传至少一个 CSV 数据文件；如果题目没有外部数据，也请上传 result1.xlsx/result2.xlsx/result3.xlsx 模板。");
  const problemPath = safePath(problemFile.storedPath);
  const problemText = await readFile(problemPath, "utf8").catch(() => "");
  const csvRows = [];
  for (const dataFile of dataFiles) {
    const dataText = await readFile(safePath(dataFile.storedPath), "utf8").catch(() => "");
    csvRows.push(...parseCsv(dataText).map((row) => ({ ...row, __source_file: dataFile.filename })));
  }
  state.project.title = String(body.title || state.project.title);
  state.project.confirmed = true;
  state.problem = { title: state.project.title, question: problemText.slice(0, 5000) || `题目文件：${problemFile.filename}`, data: dataFiles.length ? `数据文件：${dataFiles.map((file) => file.filename).join(", ")}（共 ${csvRows.length} 行）` : `题目内嵌数据；模板文件：${templates.map((file) => file.filename).join(", ")}`, rows: csvRows, files };
  await persist();
  return publicState();
}

function extensionOf(name) { return extname(name).toLowerCase(); }

async function startProject(projectId) {
  if (!state.project?.confirmed || state.project.id !== projectId) throw new HttpError(409, "请先确认题目与数据。");
  if (state.runId && !["completed", "aborted", "blocked", "idle"].includes(state.status)) throw new HttpError(409, "已有运行处于活动状态。");
  activeRunToken += 1;
  state.runId = `run-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const runDir = resolve(dataRoot, state.runId);
  await mkdir(resolve(runDir, "inputs"), { recursive: true });
  const inputManifest = [];
  for (const file of state.project.files) {
    const source = safePath(file.storedPath);
    const target = resolve(runDir, "inputs", file.filename);
    await mkdir(resolve(target, ".."), { recursive: true });
    const sourceBytes = await readFile(source);
    const actualSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const recordedSha256 = String(file.sha256 || "").toLowerCase();
    if (!isSha256(recordedSha256) || actualSha256 !== recordedSha256) {
      throw new HttpError(409, `输入文件在上传后发生变化，拒绝启动并保留原始项目：${file.filename}`);
    }
    await writeFile(target, sourceBytes);
    const copiedSha256 = await sha256File(target);
    if (copiedSha256 !== actualSha256) throw new HttpError(500, `输入文件复制后哈希不一致，已拒绝启动：${file.filename}`);
    inputManifest.push({ ...file, sha256: actualSha256, runPath: relative(projectRoot, target).replaceAll("\\", "/") });
  }
  state.problem.files = inputManifest;
  const constitutionText = `# Constitution v1.0\n\n- 不得伪造未执行的结果\n- 不得删除失败日志和历史版本\n- 每次交接必须经过 Agent Supervisor 和两次单人类审核\n- 不得自动降低数据真实性、关键公式正确性和核心验收条件\n`;
  state.constitution.sha256 = createHash("sha256").update(constitutionText).digest("hex");
  await writeText(resolve(runDir, "constitution.md"), constitutionText);
  await writeText(resolve(runDir, "problem.md"), `# ${state.problem.title}\n\n${state.problem.question}\n\n${state.problem.data}\n`);
  await writeText(resolve(runDir, "problem_manifest.json"), `${JSON.stringify({ projectId, files: inputManifest, problemSha256: createHash("sha256").update(state.problem.question).digest("hex") }, null, 2)}\n`);
  await appendEvent("run_started", { mode: config.mode, topic: state.problem.title, projectId, inputFiles: inputManifest.map((file) => file.filename) });
  await createPackage(0, 1);
  return publicState();
}

async function retryBlockedAgent() {
  if (retryInFlight) throw new HttpError(409, "当前阻断 Agent 正在重试，请等待状态刷新后再操作。");
  if (!state.package || state.status !== "blocked") throw new HttpError(409, "当前没有可重试的阻断 Agent。");
  retryInFlight = true;
  try {
    const oldPackageId = state.package.packageId;
    const stageIndex = state.package.stageIndex;
    await appendEvent("agent_retry_requested", { packageId: oldPackageId, stageKey: state.package.stageKey, message: "唯一人类要求保留旧 attempt 并重新运行当前 Agent；旧包不会被覆盖。" });
    await createPackage(stageIndex, state.package.attempt + 1);
    return publicState();
  } finally {
    retryInFlight = false;
  }
}

async function promoteCurrent() {
  const current = state.package;
  const source = safePath(current.dir);
  const approved = resolve(dataRoot, state.runId, "approved", current.stageKey, current.packageId);
  await mkdir(resolve(approved, ".."), { recursive: true });
  if (existsSync(approved)) throw new HttpError(409, "目标 approved 目录已经存在，拒绝覆盖历史交接包。");
  // 复制完整目录树，任何 Agent 附加文件都必须随同交接并经过清单哈希复核。
  const files = await listRelativeFiles(source);
  const temp = `${approved}.tmp`;
  await rm(temp, { recursive: true, force: true });
  try {
    await mkdir(temp, { recursive: true });
    for (const file of files) {
      await mkdir(resolve(temp, file, ".."), { recursive: true });
      await writeFile(resolve(temp, file), await readFile(resolve(source, file)));
    }
    const promotedManifest = JSON.parse(await readFile(resolve(temp, "manifest.json"), "utf8"));
    const promotedVerdict = await supervisorCheck(temp, currentStage(), promotedManifest);
    if (promotedVerdict.decision !== "submit_for_human_review") throw new HttpError(409, "晋级前哈希复核失败，禁止发布。");
    await rename(temp, approved);
    await chmod(approved, 0o555).catch(() => {});
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  await appendEvent("package_promoted", { packageId: current.packageId, approvedDir: relative(projectRoot, approved).replaceAll("\\", "/") });
  state.history.push({ ...current, approvedDir: relative(projectRoot, approved).replaceAll("\\", "/"), promotedAt: new Date().toISOString() });
}

function currentStage() { return STAGES[state.package?.stageIndex ?? state.stageIndex]; }

async function review(body) {
  if (reviewInFlight) throw new HttpError(409, "上一条审核正在处理，请等待页面状态刷新后再操作。");
  reviewInFlight = true;
  try {
    return await reviewUnlocked(body);
  } finally {
    reviewInFlight = false;
  }
}

async function reviewUnlocked(body) {
  if (!state.package) throw new HttpError(409, "当前没有待审核交接包。");
  if (body.packageId !== state.package.packageId) throw new HttpError(409, "审核对象已发生变化，请刷新页面。");
  const gate = body.gate;
  const decision = body.decision;
  if (!["content", "evidence"].includes(gate)) throw new HttpError(400, "gate 必须是 content 或 evidence。");
  if (!["approve", "return", "pause", "abort"].includes(decision)) throw new HttpError(400, "无效审核动作。");
  const expected = gate === "content" ? "waiting_human_review_1" : "waiting_human_review_2";
  if (state.status !== expected) throw new HttpError(409, `当前状态不是 ${expected}。`);
  const notes = String(body.notes || "").trim();
  if (notes.length < 2) throw new HttpError(400, "审核意见不能为空，且至少需要 2 个字符的可审计说明。");
  const record = { reviewId: randomUUID(), packageId: state.package.packageId, gate, decision, notes, reviewer: "human-1", time: new Date().toISOString() };
  state.humanReviews.push(record);
  await appendEvent("human_review", record);
  if (decision === "pause") {
    state.status = "paused";
  } else if (decision === "abort") {
    state.status = "aborted";
  } else if (decision === "return") {
    const notes = String(body.notes || "").trim();
    state.revisionRequests.push({
      requestId: randomUUID(),
      packageId: state.package.packageId,
      stageKey: state.package.stageKey,
      gate,
      notes,
      category: String(body.category || "general"),
      targetFiles: Array.isArray(body.targetFiles) ? body.targetFiles.map(String).slice(0, 100) : [],
      severity: String(body.severity || "blocking"),
      reviewer: "human-1",
      time: new Date().toISOString(),
    });
    await appendEvent("revision_requested", { packageId: state.package.packageId, gate, category: String(body.category || "general"), targetFiles: Array.isArray(body.targetFiles) ? body.targetFiles.map(String).slice(0, 100) : [], message: notes });
    await createPackage(state.stageIndex, state.package.attempt + 1);
    await persist();
  } else if (gate === "content") {
    state.status = "waiting_human_review_2";
    await appendEvent("human_review_required", { gate: "evidence", packageId: state.package.packageId, message: "第一审通过，等待人类第二审：证据、复现和放行" });
    await persist();
  } else {
    await promoteCurrent();
    const next = state.stageIndex + 1;
    if (next >= STAGES.length) {
      state.status = "completed";
      await appendEvent("run_completed", { message: "全部阶段完成，最终包已冻结" });
      await persist();
    } else {
      await createPackage(next, 1);
    }
  }
  await persist();
  return publicState();
}

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "请求过大。");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "JSON 格式错误。"); }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

async function serveStatic(response, pathname) {
  const relativeName = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const path = resolve(frameworkRoot, relativeName);
  if (!path.startsWith(frameworkRoot) || path.includes(`${sep}.`)) throw new HttpError(404, "Not found");
  try { response.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }); response.end(await readFile(path)); } catch { throw new HttpError(404, "Not found"); }
}

async function handle(request, response, url) {
  const origin = request.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin)) {
    throw new HttpError(403, "拒绝跨来源请求；请从本机 WebUI 发起操作。");
  }
  if (url.pathname === "/api/framework/health") return sendJson(response, 200, { ok: true, service: "supervised-framework", port });
  if (url.pathname === "/api/framework/state" && request.method === "GET") return sendJson(response, 200, publicState());
  if (url.pathname === "/api/framework/project" && request.method === "GET") return sendJson(response, 200, { project: publicProject() });
  if (url.pathname === "/api/framework/project" && request.method === "POST") return sendJson(response, 201, await createProject(await readBody(request)));
  if (url.pathname === "/api/framework/upload" && request.method === "POST") return sendJson(response, 201, await uploadProjectFiles(request));
  const confirmMatch = url.pathname.match(/^\/api\/framework\/project\/([^/]+)\/confirm$/);
  if (confirmMatch && request.method === "POST") return sendJson(response, 200, { state: await confirmProject(confirmMatch[1], await readBody(request)) });
  const startMatch = url.pathname.match(/^\/api\/framework\/project\/([^/]+)\/start$/);
  if (startMatch && request.method === "POST") return sendJson(response, 202, { state: await startProject(startMatch[1]) });
  if (url.pathname === "/api/framework/events" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const since = Number.parseInt(request.headers["last-event-id"] || "0", 10) || 0;
    for (const event of state.events.filter((item) => item.sequence > since)) response.write(`id: ${event.sequence}\nevent: framework\ndata: ${JSON.stringify(event)}\n\n`);
    response.write(": connected\n\n"); clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (url.pathname === "/api/framework/events/history" && request.method === "GET") {
    const after = Number.parseInt(url.searchParams.get("after") || "0", 10) || 0;
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 1000);
    const lines = await readFile(eventPath, "utf8").catch(() => "");
    const persistedEvents = lines.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const sourceEvents = persistedEvents.length ? persistedEvents : state.events;
    const events = sourceEvents.filter((event) => event.sequence > after).slice(0, limit);
    return sendJson(response, 200, { events, nextAfter: events.at(-1)?.sequence || after, truncated: events.length === limit });
  }
  if (url.pathname === "/api/framework/config" && request.method === "GET") return sendJson(response, 200, publicConfig());
  if (url.pathname === "/api/framework/config" && request.method === "POST") {
    const body = await readBody(request);
    config = { ...config, mode: body.mode === "live" ? "live" : "demo", apiBase: String(body.apiBase || DEFAULT_CONFIG.apiBase).replace(/\/$/, ""), model: String(body.model || ""), apiKey: body.apiKey === "__KEEP__" ? config.apiKey : String(body.apiKey || ""), temperature: Number(body.temperature ?? 0) };
    await atomicJson(configPath, config);
    await appendEvent("config_saved", { mode: config.mode, apiBase: config.apiBase, model: config.model, hasApiKey: Boolean(config.apiKey) });
    return sendJson(response, 200, publicConfig());
  }
  if (url.pathname === "/api/framework/config/test" && request.method === "POST") {
    if (config.mode === "demo") return sendJson(response, 200, { ok: true, mode: "demo", message: "演示模式不需要 API Key。" });
    if (!config.apiKey || !config.model) return sendJson(response, 400, { ok: false, message: "真实模式需要 API Key 和从 /v1/models 选择的模型名。" });
    try {
      const result = await fetch(`${config.apiBase}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
      return sendJson(response, result.ok ? 200 : 502, { ok: result.ok, status: result.status, message: result.ok ? "端点可访问，模型列表请求成功。" : "端点可访问但密钥或权限未通过。" });
    } catch (error) { return sendJson(response, 502, { ok: false, message: `无法连接端点：${error.message}` }); }
  }
  if (url.pathname === "/api/framework/demo/start" && request.method === "POST") return sendJson(response, 202, { state: await startDemo() });
  if (url.pathname === "/api/framework/retry-agent" && request.method === "POST") return sendJson(response, 202, { state: await retryBlockedAgent() });
  if (url.pathname === "/api/framework/review" && request.method === "POST") return sendJson(response, 200, await review(await readBody(request)));
  if (url.pathname === "/api/framework/control" && request.method === "POST") {
    const body = await readBody(request);
    if (!["pause", "resume", "abort"].includes(body.action)) throw new HttpError(400, "无效控制动作。");
    if (["completed", "aborted", "idle"].includes(state.status)) throw new HttpError(409, "当前运行已经结束，不能再执行暂停、恢复或终止。");
    if (body.action === "pause" && state.status === "blocked") throw new HttpError(409, "阻断状态不能暂停后伪装成可审核状态；请修复后重试或直接终止。");
    if (body.action === "pause") state.status = "paused";
    if (body.action === "resume" && state.status === "paused") state.status = state.humanReviews.at(-1)?.gate === "content" ? "waiting_human_review_2" : "waiting_human_review_1";
    if (body.action === "abort") {
      activeRunToken += 1;
      state.status = "aborted";
      if (activeChild) activeChild.kill();
    }
    await appendEvent("human_control", { action: body.action, status: state.status }); await persist();
    return sendJson(response, 200, publicState());
  }
  if (url.pathname === "/api/framework/artifact" && request.method === "GET") {
    const path = dataPath(url.searchParams.get("path"));
    const buffer = await readFile(path);
    const name = path.split(sep).at(-1);
    const previewable = isPreviewableArtifact(name) && buffer.length <= MAX_ARTIFACT_PREVIEW_BYTES;
    return sendJson(response, 200, { path: relative(projectRoot, path).replaceAll("\\", "/"), name, size: buffer.length, kind: artifactKind(name), previewable, content: previewable ? buffer.toString("utf8") : null, message: previewable ? null : "该文件为二进制、专用格式或超过在线预览大小限制，请下载后使用对应软件打开。" });
  }
  if (url.pathname === "/api/framework/download" && request.method === "GET") {
    const path = dataPath(url.searchParams.get("path"));
    const file = await readFile(path);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${cleanName(path)}"` });
    response.end(file);
    return;
  }
  return serveStatic(response, url.pathname);
}

await ensureDataRoot();
if (state.package?.dir) {
  try {
    state.package.files = await describePackageFiles(safePath(state.package.dir));
    await persist();
  } catch {
    state.package.files = state.package.files || [];
  }
}
const server = createServer(async (request, response) => {
  try { await handle(request, response, new URL(request.url, `http://${request.headers.host || "localhost"}`)); }
  catch (error) {
    if (response.headersSent) {
      try { response.end(); } catch {}
    } else {
      sendJson(response, error.status || 500, { error: error.message || "服务器错误" });
    }
  }
});
server.on("error", (error) => {
  console.error(`WebUI 无法监听 127.0.0.1:${port}：${error.message}`);
  if (error.code === "EADDRINUSE") {
    console.error("该端口已被占用。请运行 npm run start:framework，启动器会复用本服务或自动选择备用端口。");
  }
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`Supervised framework UI: http://127.0.0.1:${port}`));

export { server, projectRoot, dataRoot, initialState, STAGES };
