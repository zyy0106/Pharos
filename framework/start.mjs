import "dotenv/config";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configuredPort = Number.parseInt(process.env.FRAMEWORK_PORT || "5174", 10);

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/framework/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const body = await response.json();
    return body.service === "supervised-framework" ? body : null;
  } catch {
    return null;
  }
}

function portIsFree(port) {
  return new Promise((resolvePromise) => {
    const probe = createConnection({ host: "127.0.0.1", port });
    probe.once("connect", () => { probe.destroy(); resolvePromise(false); });
    probe.once("error", () => resolvePromise(true));
  });
}

let port = configuredPort;
const existing = await health(port);
if (existing) {
  console.log(`Supervised framework already running: http://127.0.0.1:${existing.port}`);
  console.log("Reusing the existing service; no second process was started.");
  process.exit(0);
}

while (!(await portIsFree(port))) {
  port += 1;
  if (port > 65535) throw new Error("没有可用的 WebUI 端口。");
}

if (port !== configuredPort) {
  console.log(`端口 ${configuredPort} 已被其他程序占用，改用 ${port}。`);
}
const child = spawn(process.execPath, [resolve(projectRoot, "framework", "server.mjs")], {
  cwd: projectRoot,
  env: { ...process.env, FRAMEWORK_PORT: String(port) },
  stdio: "inherit",
  windowsHide: false,
});
child.on("exit", (code, signal) => {
  if (signal) console.log(`框架服务已停止（${signal}）。`);
  process.exit(code ?? 1);
});
