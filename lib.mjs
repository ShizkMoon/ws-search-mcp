// ws/lib.mjs — 检索后端、融合、去重与缓存（CLI 与 MCP 共用，零依赖，Node >= 20）
export const EXA_KEY = () => process.env.EXA_API_KEY || "";
export const TAVILY_KEY = () => process.env.TAVILY_API_KEY || "";
export const BRAVE_KEY = () => process.env.BRAVE_API_KEY || "";
export const SEARXNG_URL = () => process.env.SEARXNG_URL || "http://127.0.0.1:8888";

const UA = "Mozilla/5.0 (compatible; ws/0.3)";

export function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|source|fbclid|gclid|spm)/i.test(k)) u.searchParams.delete(k);
    }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    const q = u.searchParams.toString();
    return host + path + (q ? "?" + q : "");
  } catch { return String(url || "").toLowerCase(); }
}

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "?"; } };

export async function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + " timeout " + ms + "ms")), ms); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

/** 瞬时错误重试一次：网络抖动与限流很常见，重试比降级划算。 */
async function withRetry(fn, tries = 2, delayMs = 400) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e && e.message || e);
      const transient = /http (429|5\d\d)|timeout|fetch failed|ECONN|ENOTFOUND/i.test(msg);
      if (!transient || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

async function jpost(url, body, headers = {}, ms = 60000, label = url) {
  const r = await withTimeout(fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), ms, label);
  const text = await r.text();
  if (!r.ok) throw new Error(label + " http " + r.status + " " + text.slice(0, 200));
  return JSON.parse(text || "{}");
}

async function jget(url, headers = {}, ms = 60000, label = url) {
  const r = await withTimeout(fetch(url, { headers }), ms, label);
  const text = await r.text();
  if (!r.ok) throw new Error(label + " http " + r.status + " " + text.slice(0, 200));
  return JSON.parse(text || "{}");
}

const exaHeaders = () => ({ "x-api-key": EXA_KEY() });
const tavilyBearer = () => ({ Authorization: "Bearer " + TAVILY_KEY() });

// ── 缓存（进程内 LRU）──────────────────────────────────────────────────────
const CACHE_TTL = Number(process.env.WS_CACHE_TTL_MS || 300000);
const CACHE_MAX = Number(process.env.WS_CACHE_MAX || 500);
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(key); return null; }
  _cache.delete(key); _cache.set(key, e);
  return e;
}
function cacheSet(key, value, ttl = CACHE_TTL) {
  _cache.set(key, { exp: Date.now() + ttl, value, at: Date.now() });
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}
export function cacheStats() { return { entries: _cache.size, ttlMs: CACHE_TTL }; }

// ── 时效性参数映射 ─────────────────────────────────────────────────────────
const RECENCY = {
  day: { brave: "pd", days: 1 },
  week: { brave: "pw", days: 7 },
  month: { brave: "pm", days: 30 },
  year: { brave: "py", days: 365 },
};
function recencyOpts(recency) {
  const r = RECENCY[recency];
  if (!r) return {};
  return {
    braveFreshness: r.brave,
    tavilyDays: r.days,
    exaStartPublished: new Date(Date.now() - r.days * 86400000).toISOString(),
  };
}

// ── 搜索：四家后端 ─────────────────────────────────────────────────────────
export async function exaSearch(q, n, ms = 8000, opts = {}) {
  if (!EXA_KEY()) throw new Error("EXA_API_KEY missing");
  const body = { query: q, type: "auto", numResults: n, contents: { highlights: { numSentences: 1 } } };
  if (opts.exaStartPublished) body.startPublishedDate = opts.exaStartPublished;
  const j = await jpost("https://api.exa.ai/search", body, exaHeaders(), ms, "exa");
  return (j.results || []).map((x) => ({
    url: x.url, title: x.title || x.url,
    snippet: (x.highlights && x.highlights[0]) || x.summary || "",
    published: x.publishedDate, provider: "exa",
  }));
}

export async function tavilySearch(q, n, ms = 8000, opts = {}) {
  if (!TAVILY_KEY()) throw new Error("TAVILY_API_KEY missing");
  const body = { api_key: TAVILY_KEY(), query: q, max_results: n, search_depth: "basic" };
  if (opts.tavilyDays) { body.days = opts.tavilyDays; body.topic = "news"; }
  const j = await jpost("https://api.tavily.com/search", body, {}, ms, "tavily");
  return (j.results || []).map((x) => ({
    url: x.url, title: x.title || x.url, snippet: (x.content || "").slice(0, 400),
    published: x.published_date, provider: "tavily",
  }));
}

export async function braveSearch(q, n, ms = 8000, opts = {}) {
  if (!BRAVE_KEY()) throw new Error("BRAVE_API_KEY missing");
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", q);
  u.searchParams.set("count", String(Math.min(20, n)));
  if (opts.braveFreshness) u.searchParams.set("freshness", opts.braveFreshness);
  const r = await withTimeout(fetch(u, {
    headers: { accept: "application/json", "x-subscription-token": BRAVE_KEY(), "user-agent": UA },
  }), ms, "brave");
  if (!r.ok) throw new Error("brave http " + r.status);
  const j = await r.json();
  return ((j.web && j.web.results) || []).map((x) => ({
    url: x.url, title: x.title || x.url,
    snippet: (x.description || "").replace(/<[^>]+>/g, "").slice(0, 400),
    published: x.age || x.page_age, provider: "brave",
  }));
}

export async function searxngSearch(q, n, ms = 8000, opts = {}) {
  const u = new URL(SEARXNG_URL() + "/search");
  u.searchParams.set("q", q); u.searchParams.set("format", "json");
  if (opts.lang) u.searchParams.set("language", opts.lang);
  const r = await withTimeout(fetch(u, { headers: { accept: "application/json" } }), ms, "searxng");
  if (!r.ok) throw new Error("searxng http " + r.status);
  const j = await r.json();
  return (j.results || []).slice(0, n).map((x) => ({
    url: x.url, title: x.title || x.url, snippet: x.content || "", published: x.publishedDate, provider: "searxng",
  }));
}

export const PROVIDERS = { exa: exaSearch, tavily: tavilySearch, brave: braveSearch, searxng: searxngSearch };
const PAID = new Set(["exa", "tavily", "brave"]);

const isCJK = (s) => /[\u4e00-\u9fff]/.test(s);
/** 付费源顺序：中文优先 Tavily，其余优先 Exa（英文基准 Exa > Brave > Tavily） */
export function paidOrder(query) {
  return isCJK(query) ? ["tavily", "brave", "exa"] : ["exa", "brave", "tavily"];
}

export function rrf(lists, k = 60) {
  const map = new Map();
  for (const { provider, items } of lists) {
    items.forEach((it, i) => {
      const key = canonical(it.url);
      const cur = map.get(key) || { url: it.url, title: it.title, snippet: "", published: it.published, providers: new Set(), score: 0 };
      cur.score += 1 / (k + i + 1);
      cur.providers.add(provider);
      if (it.snippet && it.snippet.length > (cur.snippet || "").length) cur.snippet = it.snippet;
      if (!cur.published && it.published) cur.published = it.published;
      map.set(key, cur);
    });
  }
  return [...map.values()].sort((a, b) => b.score - a.score).map((x) => ({ ...x, providers: [...x.providers] }));
}

function diversify(list, n, maxPerDomain) {
  const counts = new Map();
  const picked = [];
  for (const r of list) {
    const h = hostOf(r.url);
    const c = counts.get(h) || 0;
    if (maxPerDomain > 0 && c >= maxPerDomain) continue;
    counts.set(h, c + 1);
    picked.push(r);
    if (picked.length >= n) break;
  }
  return picked;
}

/**
 * 聚合检索。
 * @param {string} query
 * @param {{n?:number, paid?:number, providers?:string[]|null, recency?:string|null,
 *          maxPerDomain?:number, queries?:string[], deadlineMs?:number,
 *          snippetHead?:number, snippetRest?:number}} o
 */
export async function search(query, o = {}) {
  const {
    n = 25, paid = 1, recency = null, maxPerDomain = 3,
    deadlineMs = 8000, snippetHead = 400, snippetRest = 240,
  } = o;
  const queries = (o.queries && o.queries.length ? o.queries : [query]).slice(0, 4);
  const providers = o.providers || [...paidOrder(query), "searxng"];
  const opts = recencyOpts(recency);

  const cacheKey = "s:" + JSON.stringify([queries, n, paid, providers, recency, maxPerDomain]);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit.value, elapsedMs: 0, cached: true, cacheAgeMs: Date.now() - hit.at, originalElapsedMs: hit.value.elapsedMs };

  let paidUsed = 0;
  const names = providers.filter((p) => {
    if (!PROVIDERS[p]) return false;
    if (PAID.has(p)) { if (paidUsed >= paid) return false; paidUsed++; }
    return true;
  });

  const t0 = Date.now();
  const jobs = [];
  for (const p of names) for (const q of queries) {
    jobs.push((async () => {
      const s = Date.now();
      const items = await withRetry(() => PROVIDERS[p](q, n, deadlineMs, opts));
      return { provider: p, query: q, items, ms: Date.now() - s };
    })());
  }
  const settled = await Promise.allSettled(jobs);

  const meta = new Map();
  const lists = [];
  settled.forEach((r, i) => {
    const p = names[Math.floor(i / queries.length)];
    const m = meta.get(p) || { provider: p, count: 0, ms: 0 };
    if (r.status === "fulfilled") {
      m.count += r.value.items.length;
      m.ms = Math.max(m.ms, r.value.ms);
      lists.push({ provider: r.value.provider, items: r.value.items });
    } else if (!m.error) {
      m.error = String((r.reason && r.reason.message) || r.reason);
    }
    meta.set(p, m);
  });

  const merged = diversify(rrf(lists), n, maxPerDomain).map((r, i) => ({
    ...r,
    snippet: (r.snippet || "").slice(0, i < 5 ? snippetHead : snippetRest),
  }));

  const out = {
    query, queries, elapsedMs: Date.now() - t0,
    providers: [...meta.values()], results: merged, cached: false,
  };
  cacheSet(cacheKey, out);
  return out;
}

// ── 正文抽取 ────────────────────────────────────────────────────────────────
export async function fetchText(url, max = 3000) {
  const cacheKey = "f:" + url + ":" + max;
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit.value, elapsedMs: 0, cached: true, cacheAgeMs: Date.now() - hit.at };

  const r = await withTimeout(fetch(url, { headers: { "user-agent": UA } }), 20000, "fetch");
  const text = await r.text();
  const clean = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const out = {
    url, status: r.status, title: (text.match(/<title[^>]*>([^<]*)</i) || [, ""])[1],
    chars: clean.length, text: clean.slice(0, max), cached: false,
  };
  cacheSet(cacheKey, out, 600000);
  return out;
}

export async function tavilyExtract(urls, { depth = "basic" } = {}) {
  if (!TAVILY_KEY()) throw new Error("TAVILY_API_KEY missing");
  const key = "x:" + JSON.stringify([urls, depth]);
  const hit = cacheGet(key);
  if (hit) return { ...hit.value, cached: true, cacheAgeMs: Date.now() - hit.at };

  const j = await jpost("https://api.tavily.com/extract", {
    api_key: TAVILY_KEY(), urls: Array.isArray(urls) ? urls : [urls], extract_depth: depth,
  }, {}, 60000, "tavily.extract");
  const out = {
    results: (j.results || []).map((x) => ({ url: x.url, title: x.title, chars: (x.raw_content || "").length, text: (x.raw_content || "").slice(0, 4000) })),
    failed: j.failed_results || [], cached: false,
  };
  cacheSet(key, out, 600000);
  return out;
}

// ── 站点级：crawl / map ────────────────────────────────────────────────────
function sameHost(url, base) {
  try {
    const h = hostOf(url), b = hostOf(base);
    return h === b || h.endsWith("." + b);
  } catch { return false; }
}

async function pollTavilyKind(path, id, { timeoutMs = 180000, intervalMs = 4000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = await jget("https://api.tavily.com/" + path + "/" + id, tavilyBearer(), 30000, "tavily." + path);
    if (j.status && j.status !== "pending" && j.status !== "in_progress" && j.status !== "running") return j;
    if (j.results) return j;
    if (Date.now() - t0 > timeoutMs) return { ...j, timedOut: true };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function tavilyCrawl(url, { limit = 20, maxDepth = 1, maxBreadth = 20, instructions } = {}) {
  if (!TAVILY_KEY()) throw new Error("TAVILY_API_KEY missing");
  const key = "c:" + JSON.stringify([url, limit, maxDepth, instructions]);
  const hit = cacheGet(key);
  if (hit) return { ...hit.value, cached: true, cacheAgeMs: Date.now() - hit.at };

  const body = { url, max_depth: maxDepth, max_breadth: maxBreadth, limit };
  if (instructions) body.instructions = instructions;
  let j = await jpost("https://api.tavily.com/crawl", body, tavilyBearer(), 120000, "tavily.crawl");
  if (!j.results && j.request_id) j = await pollTavilyKind("crawl", j.request_id);
  const out = {
    baseUrl: url, timedOut: !!j.timedOut,
    pages: (j.results || []).filter((x) => sameHost(x.url, url)).map((x) => ({ url: x.url, chars: (x.raw_content || "").length, text: (x.raw_content || "").slice(0, 3000) })),
    cached: false,
  };
  cacheSet(key, out, 600000);
  return out;
}

export async function tavilyMap(url, { limit = 50, maxDepth = 2, maxBreadth = 20 } = {}) {
  if (!TAVILY_KEY()) throw new Error("TAVILY_API_KEY missing");
  const key = "m:" + JSON.stringify([url, limit, maxDepth]);
  const hit = cacheGet(key);
  if (hit) return { ...hit.value, cached: true, cacheAgeMs: Date.now() - hit.at };

  let j = await jpost("https://api.tavily.com/map", { url, max_depth: maxDepth, max_breadth: maxBreadth, limit }, tavilyBearer(), 120000, "tavily.map");
  if (!j.results && j.request_id) j = await pollTavilyKind("map", j.request_id);
  const urls = (j.results || []).map((x) => (typeof x === "string" ? x : x.url)).filter((u) => sameHost(u, url));
  const out = { baseUrl: url, count: urls.length, urls, cached: false };
  cacheSet(key, out, 3600000);
  return out;
}

// ── 研究：Tavily research / Exa agent（异步）────────────────────────────────
export async function tavilyResearch(input, { model = "auto", timeoutMs = 240000 } = {}) {
  if (!TAVILY_KEY()) throw new Error("TAVILY_API_KEY missing");
  const key = "r:" + JSON.stringify([input, model]);
  const hit = cacheGet(key);
  if (hit) return { ...hit.value, cached: true, cacheAgeMs: Date.now() - hit.at };

  const created = await jpost("https://api.tavily.com/research", { input, model }, tavilyBearer(), 60000, "tavily.research");
  const t0 = Date.now();
  let j = created;
  while (j.status && j.status !== "completed" && j.status !== "failed") {
    if (Date.now() - t0 > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 4000));
    j = await jget("https://api.tavily.com/research/" + created.request_id, tavilyBearer(), 60000, "tavily.research.poll");
  }
  const out = {
    engine: "tavily", input, model, status: j.status || "unknown",
    answer: j.content || j.answer || j.output || j.result || null,
    sources: (j.sources || j.results || []).slice(0, 20),
    elapsedMs: Date.now() - t0, cached: false,
  };
  if (j.status === "completed") cacheSet(key, out, 1800000);
  return out;
}

export async function exaAgent(query, { effort = "auto", timeoutMs = 300000 } = {}) {
  if (!EXA_KEY()) throw new Error("EXA_API_KEY missing");
  const key = "a:" + JSON.stringify([query, effort]);
  const hit = cacheGet(key);
  if (hit) return { ...hit.value, cached: true, cacheAgeMs: Date.now() - hit.at };

  const created = await jpost("https://api.exa.ai/agent/runs", { query, effort }, exaHeaders(), 60000, "exa.agent");
  const t0 = Date.now();
  let j = created;
  while (j.status && j.status !== "completed" && j.status !== "failed") {
    if (Date.now() - t0 > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 4000));
    j = await jget("https://api.exa.ai/agent/runs/" + created.id, exaHeaders(), 60000, "exa.agent.poll");
  }
  const out = {
    engine: "exa", query, status: j.status || "unknown", id: created.id,
    text: j.output?.text ?? null, structured: j.output?.structured ?? null,
    costDollars: j.costDollars ?? null, elapsedMs: Date.now() - t0, cached: false,
  };
  if (j.status === "completed") cacheSet(key, out, 1800000);
  return out;
}
