import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = readFileSync(0, "utf8");
const child = spawn(process.execPath, [fileURLToPath(new URL("./process-worker.mjs", import.meta.url))], {
  detached: true, stdio: ["pipe", "ignore", "ignore"], env: process.env,
});
child.stdin.end(config);
child.unref();
process.stdout.write(JSON.stringify({ pid: child.pid }) + "\n");
