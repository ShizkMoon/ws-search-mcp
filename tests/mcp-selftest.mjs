// mcp-selftest.mjs — 起一个真的 stdio MCP 子进程，走完整握手：initialize → tools/list → ws_env。
// 不联外网（ws_env 只读环境变量与缓存元数据），适合放进 CI 或提交前跑。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(dirname(fileURLToPath(import.meta.url))), "ws-mcp.mjs");
const EXPECTED = ["ws_search", "ws_fetch", "ws_map", "ws_crawl", "ws_research", "ws_agent", "ws_deep", "ws_env"];

const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

let nextId = 1;
const waiting = new Map();
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const pending = waiting.get(msg.id);
  if (!pending) return;
  waiting.delete(msg.id);
  msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
});

function call(method, params) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error("timeout: " + method)); }, 15000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}

let failed = false;
try {
  const init = await call("initialize", { protocolVersion: "2025-06-18" });
  console.log("  ok  握手 " + init.serverInfo.name + " " + init.serverInfo.version);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await call("tools/list", {});
  const names = list.tools.map((t) => t.name);
  for (const want of EXPECTED) if (!names.includes(want)) throw new Error("缺工具 " + want);
  if (names.length !== EXPECTED.length) throw new Error("工具数不符: " + names.join(","));
  const missingSchema = list.tools.filter((t) => !t.description || !t.inputSchema || t.inputSchema.type !== "object");
  if (missingSchema.length) throw new Error("工具元数据不全: " + missingSchema.map((t) => t.name).join(","));
  console.log("  ok  tools/list 返回 " + names.length + " 个工具，元数据齐全");

  const env = await call("tools/call", { name: "ws_env", arguments: {} });
  const envBody = JSON.parse(env.content[0].text);
  if (envBody.missing.length !== 0) throw new Error("密钥缺失: " + envBody.missing.join(","));
  if (!envBody.envFile.endsWith(".env")) throw new Error(".env 路径不对: " + envBody.envFile);
  if (typeof envBody.cache.diskEntries !== "number") throw new Error("缓存统计缺失");
  if (!envBody.libVersion) throw new Error("缺少 libVersion，热加载状态未知");
  console.log("  ok  ws_env 四把钥匙就位，libVersion=" + envBody.libVersion);

  const bad = await call("tools/call", { name: "nope", arguments: {} });
  if (!bad.isError) throw new Error("未知工具没有报错");
  console.log("  ok  未知工具返回 isError");

  console.log("\nMCP 自检通过");
} catch (e) {
  failed = true;
  console.error("  FAIL  " + (e && e.message ? e.message : e));
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
