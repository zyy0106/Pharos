import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [, , command, ...args] = process.argv;
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : null;

if (out) {
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "checkpoints.sqlite"), "test checkpoint");
}

if (command === "supervise-recover") {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  if (out?.includes("recover-blocked")) {
    process.stderr.write("[BLOCKED] simulated recovery budget exhausted\n");
    process.exit(1);
  }
  process.stdout.write("supervised run completed\n");
  process.exit(0);
}

process.stderr.write("simulated run failure\n");
process.exit(1);
