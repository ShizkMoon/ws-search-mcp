#!/usr/bin/env node
// ws — 检索网关 CLI（薄壳，逻辑在 lib.mjs）
import { search, fetchText } from "./lib.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };

if (cmd === "search") {
  const q = flag("q", "");
  if (!q) { console.error('usage: wsch --q "query" [--n 10] [--paid 1] [--providers exa,tavily,searxng]'); process.exit(2); }
  const out = await search(q, {
    n: Number(flag("n", 10)),
    paid: Number(flag("paid", 1)),
    providers: String(flag("providers", "exa,tavily,brave,searxng")).split(",").map((s) => s.trim()).filter(Boolean),
  });
  if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log("query:", out.query, "| " + out.elapsedMs + "ms |", out.providers.map((p) => p.provider + ":" + (p.error ? "ERR" : p.count)).join(" "));
    out.results.forEach((r, i) => console.log((i + 1) + ". [" + r.providers.join("+") + "] " + r.title + "\n   " + r.url));
  }
} else if (cmd === "fetch") {
  const url = flag("url", "");
  if (!url) { console.error("usage: ws fetch --url <url> [--max 3000]"); process.exit(2); }
  console.log(JSON.stringify(await fetchText(url, Number(flag("max", 3000))), null, 2));
} else {
  console.log("usage: node ws.mjs <search|fetch> ...");
  process.exit(2);
}
