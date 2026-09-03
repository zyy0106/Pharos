// frontend/routes/env.mjs
import { execFileSync, execSync } from "node:child_process";
import { sendJson, readJsonBody, HttpError, projectRoot } from "../lib/shared.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 检测单个工具的版本信息。
 * @param {string} command - 命令名 (如 "python", "node", "uv")
 * @returns {{ installed: boolean, version: string }}
 */
function checkTool(command, args = []) {
  try {
    const output = execFileSync(command, [...args, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // 提取版本号：取输出中第一个 x.y.z 格式的字符串
    const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
    return { installed: true, version: match ? match[1] : output };
  } catch {
    return { installed: false, version: "" };
  }
}

/**
 * 比较版本号是否达标。
 * @param {string} version - 实际版本 "3.12.3"
 * @param {string} minVersion - 最低要求 "3.11"
 * @returns {boolean}
 */
function versionOk(version, minVersion) {
  if (!version) return false;
  const actual = version.split(".").map(Number);
  const required = minVersion.split(".").map(Number);
  for (let i = 0; i < required.length; i++) {
    const a = actual[i] || 0;
    const r = required[i] || 0;
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

function pythonVersionOk(version) {
  return versionOk(version, "3.11") && !versionOk(version, "3.14");
}

const WINGET_PACKAGES = {
  python: "Python.Python.3.12",
  node: "OpenJS.NodeJS.LTS",
  uv: "astral-sh.uv",
};

const DOWNLOAD_URLS = {
  python: "https://www.python.org/downloads/",
  node: "https://nodejs.org/",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
};

/**
 * 处理 /api/env/* 和 /api/providers 路由。
 */
export async function handleEnvRoutes(request, response, url) {
  // GET /api/env/check - 检测环境
  if (request.method === "GET" && url.pathname === "/api/env/check") {
    const venvPython = resolve(
      projectRoot,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const pythonCandidates = [
      ...(existsSync(venvPython) ? [[venvPython, []]] : []),
      ["python", []],
      ["python3", []],
      ["py", ["-3.13"]],
    ];
    const python = pythonCandidates
      .map(([command, args]) => checkTool(command, args))
      .find((result) => result.installed) || { installed: false, version: "" };
    const node = checkTool("node");
    const uv = checkTool("uv");

    const pythonResult = python;

    sendJson(response, 200, {
      python: {
        installed: pythonResult.installed,
        version: pythonResult.version,
        ok: pythonResult.installed && pythonVersionOk(pythonResult.version),
      },
      node: {
        installed: node.installed,
        version: node.version,
        ok: node.installed && versionOk(node.version, "18"),
      },
      uv: {
        installed: uv.installed,
        version: uv.version,
        ok: uv.installed,
      },
      allOk:
        pythonResult.installed &&
        pythonVersionOk(pythonResult.version) &&
        node.installed &&
        versionOk(node.version, "18") &&
        uv.installed,
    });
    return;
  }

  // POST /api/env/install - winget 安装
  if (request.method === "POST" && url.pathname === "/api/env/install") {
    const body = await readJsonBody(request);
    const tool = body.tool;
    if (!tool || !WINGET_PACKAGES[tool]) {
      throw new HttpError(400, `Invalid tool. Must be one of: ${Object.keys(WINGET_PACKAGES).join(", ")}`);
    }

    // 检查 winget 是否可用
    try {
      execSync("winget --version", { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      sendJson(response, 200, {
        tool,
        status: "failed",
        message: "winget 不可用，请手动安装",
        downloadUrl: DOWNLOAD_URLS[tool],
      });
      return;
    }

    // 阻塞式安装
    const pkg = WINGET_PACKAGES[tool];
    try {
      const output = execSync(
        `winget install ${pkg} --silent --accept-package-agreements --accept-source-agreements`,
        {
          encoding: "utf8",
          timeout: 300_000, // 5 分钟
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      sendJson(response, 200, {
        tool,
        status: "done",
        message: "安装完成",
        output: output.slice(-500),
      });
    } catch (error) {
      sendJson(response, 200, {
        tool,
        status: "failed",
        message: error.killed ? "安装超时（超过5分钟）" : "安装失败",
        output: String(error.stderr || error.stdout || error.message).slice(-500),
        downloadUrl: DOWNLOAD_URLS[tool],
      });
    }
    return;
  }

  // GET /api/providers - 返回提供商预设
  if (request.method === "GET" && url.pathname === "/api/providers") {
    try {
      const raw = await readFile(resolve(projectRoot, "frontend/providers.json"), "utf8");
      sendJson(response, 200, JSON.parse(raw));
    } catch {
      sendJson(response, 200, []);
    }
    return;
  }

  sendJson(response, 404, { error: "Unknown env route." });
}
