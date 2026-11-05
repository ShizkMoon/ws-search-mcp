// smoke.mjs — 自检。默认只跑离线断言（不花钱、不联网）；
// `node tests/smoke.mjs --live` 才真的打四家源，验证类型路由、正文增强、去重与取消。
import assert from "node:assert/strict";
import {
  canonical, hostOf, rrf, authorityOf, paidOrder, detectQueryType,
  abortedError, throwIfAborted, envStatus, loadEnvFile, search, fetchText,
} from "../lib.mjs";

let pass = 0;
const ok = (name) => { pass += 1; console.log("  ok  " + name); };

// ── 离线：纯函数 ────────────────────────────────────────────────────────────
function offline() {
  console.log("offline");

  assert.equal(canonical("https://www.Example.com/A/b/?utm_source=x&q=1#frag"), "example.com/A/b?q=1");
  assert.equal(canonical("https://example.com/a/"), "example.com/a");
  assert.equal(hostOf("https://www.example.com/x"), "example.com");
  ok("canonical / hostOf");

  assert.deepEqual(paidOrder("最新 AI 新闻"), ["tavily", "brave", "exa"]);
  assert.deepEqual(paidOrder("latest AI news"), ["exa", "brave", "tavily"]);
  ok("paidOrder 按语言选源");

  const kinds = [
    ["site:github.com deepseek", "navigational", null, false],
    ["https://x.com/a", "navigational", null, false],
    ["deepseek harness 最新发布", "news", "week", false],
    ["Exa vs Tavily 对比", "comparative", null, true],
    ["如何部署 MCP server", "howto", null, true],
    ["DeepSeek Harness 是什么", "factual", null, true],
  ];
  for (const [q, type, recency, enrich] of kinds) {
    const d = detectQueryType(q);
    assert.equal(d.type, type, q);
    assert.equal(d.recency, recency, q);
    assert.equal(d.enrich, enrich, q);
  }
  ok("detectQueryType 五种类型");

  assert.equal(authorityOf("en.wikipedia.org"), 1.25);
  assert.equal(authorityOf("docs.example.com"), 1.2);
  assert.equal(authorityOf("reddit.com"), 0.9);
  assert.equal(authorityOf("someblog.io"), 1);
  ok("authorityOf");

  // 同一 URL 出现在两个源里时只留一条，分数叠加，providers 合并
  const merged = rrf([
    { provider: "exa", items: [{ url: "https://a.com/1", title: "a1", snippet: "short", published: null }, { url: "https://b.com/2", title: "b2", snippet: "", published: "2026-01-01" }] },
    { provider: "brave", items: [{ url: "https://a.com/1?utm_source=z", title: "a1", snippet: "a much longer snippet", published: "2025-12-31" }] },
  ]);
  assert.equal(merged.length, 2);
  const a = merged.find((r) => r.url.includes("a.com"));
  assert.deepEqual(a.providers.sort(), ["brave", "exa"]);
  assert.equal(a.snippet, "a much longer snippet", "保留较长摘要");
  assert.equal(a.published, "2025-12-31", "补齐缺失时间");
  ok("rrf 去重与合并");

  const err = abortedError({ aborted: true, reason: "user" });
  assert.equal(err.code, "cancelled");
  assert.throws(() => throwIfAborted({ aborted: true }), (e) => e.code === "cancelled");
  throwIfAborted({ aborted: false });
  throwIfAborted(undefined);
  ok("abortedError / throwIfAborted");

  const s = envStatus();
  assert.equal(typeof s.envFile, "string");
  assert.ok(Array.isArray(s.missing));
  assert.ok(!("EXA_API_KEY_value" in s), "envStatus 不回密钥值");
  ok("envStatus 不泄漏密钥");
}

// ── 联网：类型路由、正文增强、去重、取消 ────────────────────────────────────
async function live() {
  console.log("live");
  const loaded = loadEnvFile(undefined, { override: true });
  console.log("  env  " + loaded.file + " found=" + loaded.found + " loaded=" + loaded.loaded.length);
  assert.ok(loaded.found, "找不到 .env: " + loaded.file);
  assert.deepEqual(envStatus().missing, [], "密钥不全: " + envStatus().missing.join(","));
  ok("四把钥匙就位");

  const cases = [
    ["dsh-market 插件市场 安装", "factual"],
    ["deepseek harness 最新发布", "news"],
    ["Exa vs Tavily 检索 API 对比", "comparative"],
    ["如何用 node 部署 MCP server", "howto"],
    ["site:github.com deepseek-ai deepseek-harness", "navigational"],
  ];
  for (const [q, type] of cases) {
    const out = await search(q, { n: 12, maxPerDomain: 2 });
    assert.ok(out.results.length > 0, q + " 无结果");
    assert.equal(out.type, type, q + " 类型判定 " + out.type);
    orThrow(out.results.every((r) => /^https?:\/\//.test(r.url)), q + " 有非 http 结果");
    const keys = out.results.map((r) => canonical(r.url));
    assert.equal(new Set(keys).size, keys.length, q + " 有重复 URL");
    const hosts = new Map();
    for (const r of out.results) hosts.set(hostOf(r.url), (hosts.get(hostOf(r.url)) || 0) + 1);
    orThrow([...hosts.values()].every((c) => c <= 2), q + " maxPerDomain 失效");
    const enriched = out.results.filter((r) => typeof r.content === "string" && r.content.length > 0).length;
    console.log(`  ${q} → ${out.results.length} 条, type=${out.type}, recency=${out.recency}, enrich=${out.enriched}, 带正文 ${enriched} 条, ${out.elapsedMs}ms`);
    if (out.enriched) orThrow(enriched > 0, q + " enrich=on 但没抓到正文");
    ok("类型 " + type);
  }

  // 立即取消：不该发请求，直接 cancelled
  const ac = new AbortController();
  ac.abort("test");
  await assert.rejects(search("随便什么", { signal: ac.signal }), (e) => e.code === "cancelled");
  await assert.rejects(fetchText("https://example.com", 100, ac.signal), (e) => e.code === "cancelled");
  ok("已取消的 signal 直接抛 cancelled");

  // 飞行中取消：聚合途中打断，仍然只抛 cancelled，不返回半成品
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort("later"), 30);
  await assert.rejects(search("kubernetes operator 是什么", { n: 12, signal: ac2.signal }), (e) => e.code === "cancelled");
  ok("飞行中取消 → cancelled");
}

function orThrow(cond, msg) { if (!cond) throw new Error(msg); }

const run = process.argv.includes("--live");
offline();
if (run) await live();
console.log(`\n${pass} 项通过${run ? "" : "（离线）"}`);
