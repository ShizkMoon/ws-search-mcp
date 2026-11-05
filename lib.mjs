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

/** 取消错误：带 code=cancelled，调用方可以把它和其他失败区分开，不重试、不缓存。 */
export function abortedError(signal) {
  const e = new Error("aborted by caller");
  e.name = "AbortError";
  e.code = "cancelled";
  if (signal && signal.reason !== undefined) e.cause = signal.reason;
  return e;
}
/** 每个阶段边界检查一次；已取消就立刻抛，不再发新请求。 */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortedError(signal);
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

async function jpost(url, body, headers = {}, ms = 60000, label = url, signal) {
  throwIfAborted(signal);
  const r = await withTimeout(fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal,
  }), ms, label);
  const text = await r.text();
  if (!r.ok) throw new Error(label + " http " + r.status + " " + text.slice(0, 200));
  return JSON.parse(text || "{}");
}

async function jget(url, headers = {}, ms = 60000, label = url, signal) {
  throwIfAborted(signal);
  const r = await withTimeout(fetch(url, { headers, signal }), ms, label);
  const text = await r.text();
  if (!r.ok) throw new Error(label + " http " + r.status + " " + text.slice(0, 200));
  return JSON.parse(text || "{}");
}

const exaHeaders = () => ({ "x-api-key": EXA_KEY() });
const tavilyBearer = () => ({ Authorization: "Bearer " + TAVILY_KEY() });


// ── 查询类型识别（n 恒为 25，只有时效/付费档/正文增强随类型变）──────────────
export function detectQueryType(q) {
  const s = String(q || "");
  if (/\bsite:\S+/i.test(s) || /^https?:\/\//.test(s)) return { type: "navigational", recency: null, paid: 1, enrich: false };
  if (/(最新|今天|今日|本周|近日|刚刚|突发|融资|公告|财报|发布|latest|today|this week|breaking|news|announce)/i.test(s))
    return { type: "news", recency: "week", paid: 1, enrich: false };
  if (/(对比|比较|哪个好|选型|推荐|选购|排行|vs\b|versus|compare|comparison|best |top \d|alternative)/i.test(s))
    return { type: "comparative", recency: null, paid: 2, enrich: true };
  if (/(如何|怎么|怎样|教程|步骤|配置|部署|how to|tutorial|guide|setup|install|configure|example)/i.test(s))
    return { type: "howto", recency: null, paid: 1, enrich: true };
  return { type: "factual", recency: null, paid: 1, enrich: true };
}

// ── 权威度权重（乘在 RRF 分数上，不改召回，只微调排序）────────────────────
const AUTH_BOOST = [
  [/(^|\.)wikipedia\.org$|(^|\.)arxiv\.org$|\.edu$|\.gov$/, 1.25],
  [/(^|\.)github\.com$|(^|\.)docs\.|^developer\.|(^|\.)mozilla\.org$|(^|\.)nodejs\.org$|(^|\.)python\.org$|(^|\.)kubernetes\.io$/, 1.2],
  [/(^|\.)stackoverflow\.com$|(^|\.)stackexchange\.com$/, 1.1],
];
const AUTH_PENALTY = [
  [/(^|\.)(alphacorp|iternal|olostep|vdf|recatools|keirolabs|webscraft|cooldev|thestatuscode|hyper|sphereinc)\.(ai|com|cloud|org|tools|dev)$/, 0.75],
  [/(^|\.)quora\.com$|(^|\.)reddit\.com$/, 0.9],
];
export function authorityOf(host) {
  const h = String(host || "").toLowerCase();
  for (const [re, w] of AUTH_BOOST) if (re.test(h)) return w;
  for (const [re, w] of AUTH_PENALTY) if (re.test(h)) return w;
  return 1;
}

// ── 缓存（进程内 LRU + 跨进程落盘共享）──────────────────────────────────────
// MCP 进程和 DSH 主进程（ws-web provider）各跑一份 lib.mjs，原来缓存各存各的，
// 同一个 query 会被两处重复付费。这里把缓存落盘成一份共享文件，两边都读它：
// 命中时零延迟、不再计费。写入用 tmp+rename 保证原子，落盘前先合并盘上另一个
// 进程刚写进去的条目，避免互相覆盖。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { homedir } from "node:os";

const CACHE_TTL = Number(process.env.WS_CACHE_TTL_MS || 300000);
const CACHE_MAX = Number(process.env.WS_CACHE_MAX || 500);
const DISK_ON = process.env.WS_CACHE_DISK !== "0";
const DISK_DIR = process.env.WS_CACHE_DIR || pathJoin(homedir(), ".dsh", "cache");
const DISK_FILE = pathJoin(DISK_DIR, "ws-cache.json");
const DISK_MAX = Number(process.env.WS_CACHE_DISK_MAX || 1200);
const DISK_VALUE_MAX = Number(process.env.WS_CACHE_VALUE_MAX || 400000);
const _cache = new Map();
let _disk = null;
let _flushTimer = null;

function loadDisk() {
  if (_disk || !DISK_ON) return _disk;
  _disk = new Map();
  try {
    const raw = JSON.parse(readFileSync(DISK_FILE, "utf8"));
    for (const [k, e] of Object.entries(raw.entries || {})) if (e && e.exp > Date.now()) _disk.set(k, e);
  } catch { /* 首次运行或文件损坏：从空开始 */ }
  return _disk;
}

function flushDisk() {
  _flushTimer = null;
  if (!DISK_ON || !_disk) return;
  try {
    const t = Date.now();
    for (const [k, e] of _disk) if (!e || e.exp <= t) _disk.delete(k);
    // 合并另一个进程可能刚写进去的新条目，谁新用谁
    try {
      const raw = JSON.parse(readFileSync(DISK_FILE, "utf8"));
      for (const [k, e] of Object.entries(raw.entries || {})) {
        if (!e || e.exp <= t) continue;
        const mine = _disk.get(k);
        if (!mine || (e.at || 0) > (mine.at || 0)) _disk.set(k, e);
      }
    } catch { /* 还没有旧文件 */ }
    while (_disk.size > DISK_MAX) _disk.delete(_disk.keys().next().value);
    mkdirSync(DISK_DIR, { recursive: true });
    const tmp = `${DISK_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(_disk) }));
    renameSync(tmp, DISK_FILE);
  } catch { /* 落盘失败只影响共享，不影响检索 */ }
}

function scheduleFlush() {
  if (!DISK_ON || _flushTimer) return;
  _flushTimer = setTimeout(flushDisk, 250);
  if (typeof _flushTimer.unref === "function") _flushTimer.unref();
}
process.on("exit", () => { if (_flushTimer) flushDisk(); });

function cacheGet(key) {
  const e = _cache.get(key);
  if (e) {
    if (Date.now() > e.exp) _cache.delete(key);
    else { _cache.delete(key); _cache.set(key, e); return e; }
  }
  const d = loadDisk();
  const de = d && d.get(key);
  if (!de) return null;
  if (Date.now() > de.exp) { d.delete(key); return null; }
  _cache.set(key, de);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  return de;
}
function cacheSet(key, value, ttl = CACHE_TTL) {
  const e = { exp: Date.now() + ttl, value, at: Date.now() };
  _cache.set(key, e);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  if (!DISK_ON) return;
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { return; }
  if (size > DISK_VALUE_MAX) return;
  const d = loadDisk();
  if (!d) return;
  d.set(key, e);
  scheduleFlush();
}
export function cacheStats() {
  const d = loadDisk();
  return { entries: _cache.size, diskEntries: d ? d.size : 0, ttlMs: CACHE_TTL, disk: DISK_ON ? DISK_FILE : null };
}

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
  const j = await jpost("https://api.exa.ai/search", body, exaHeaders(), ms, "exa", opts.signal);
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
  const j = await jpost("https://api.tavily.com/search", body, {}, ms, "tavily", opts.signal);
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
    signal: opts.signal,
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
  const r = await withTimeout(fetch(u, { headers: { accept: "application/json" }, signal: opts.signal }), ms, "searxng");
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
  throwIfAborted(o.signal);
  const det = detectQueryType(query);
  const {
    n = 25, maxPerDomain = 3, deadlineMs = 8000,
    snippetHead = 400, snippetRest = 240, enrichTop = 3, enrichChars = 1200,
  } = o;
  const paid = o.paid ?? det.paid;
  const recency = o.recency ?? det.recency;
  const enrich = o.enrich ?? det.enrich;
  const queries = (o.queries && o.queries.length ? o.queries : [query]).slice(0, 4);
  const providers = o.providers || [...paidOrder(query), "searxng"];
  const opts = { ...recencyOpts(recency), signal: o.signal };

  const cacheKey = "s:" + JSON.stringify([queries, n, paid, providers, recency, maxPerDomain, enrich]);
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
  // 取消发生在聚合途中：不返回半成品，也不写缓存。
  throwIfAborted(o.signal);

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

  // 权威度微调：乘在 RRF 分数上，只改排序不改召回
  const weighted = rrf(lists)
    .map((r) => ({ ...r, score: +(r.score * authorityOf(hostOf(r.url))).toFixed(6) }))
    .sort((a, b) => b.score - a.score);

  const merged = diversify(weighted, n, maxPerDomain).map((r, i) => ({
    ...r,
    snippet: (r.snippet || "").slice(0, i < 5 ? snippetHead : snippetRest),
  }));

  // 正文增强：给前几条附真实正文，便于判断是否值得深入（本机抓取、免费、有缓存）
  if (enrich && merged.length) {
    await Promise.all(merged.slice(0, enrichTop).map(async (r) => {
      try {
        const f = await fetchText(r.url, enrichChars, o.signal);
        r.contentChars = f.chars;
        r.content = f.text;
      } catch (e) {
        if (e && e.code === "cancelled") throw e;
        r.contentError = String((e && e.message) || e).slice(0, 80);
      }
    }));
  }
  throwIfAborted(o.signal);

  const out = {
    query, queries, type: det.type, recency, enriched: enrich,
    elapsedMs: Date.now() - t0, providers: [...meta.values()], results: merged, cached: false,
  };
  cacheSet(cacheKey, out);
  return out;
}

// ── 正文抽取 ────────────────────────────────────────────────────────────────
export async function fetchText(url, max = 3000, signal) {
  throwIfAborted(signal);
  const cacheKey = "f:" + url + ":" + max;
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit.value, elapsedMs: 0, cached: true, cacheAgeMs: Date.now() - hit.at };

  const r = await withTimeout(fetch(url, { headers: { "user-agent": UA }, signal }), 20000, "fetch");
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

// ── 深度检索：分解 → 多路检索 → 回读正文 → 覆盖度评估 → 缺口补搜 ──────────────
// 单轮 search 只给标题和摘要，判断不了"讲没讲透"。deepSearch 把同一问题拆成几个
// 面（原理、对比、排错），抓回正文，用问题里的术语去量覆盖度，没覆盖够就带着缺口
// 再搜一轮，最后只回带原文引句的证据，供上层直接判断可信度。
const STOP_EN = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "how", "what", "why", "best", "vs", "with", "from", "by", "at", "as", "that", "this", "it", "be", "can", "do", "does", "not", "you", "your"]);
const STOP_ZH = new Set(["这个", "那个", "什么", "怎么", "如何", "哪些", "为什", "是否", "多少", "哪个", "以及", "还有", "我们", "你们", "他们", "可以", "需要", "一个", "进行", "通过", "关于", "对于", "如果", "因为", "所以", "就是", "不是", "没有", "现在", "目前"]);

/** 从问题里抽术语：拉丁词 + 中文短段（按虚词切开），术语太少时补二元组。 */
export function termsOf(query) {
  const latin = (query.match(/[A-Za-z][A-Za-z0-9+_.\-]{1,}/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOP_EN.has(w));
  const cjkRuns = query.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const out = new Set(latin);
  for (const run of cjkRuns) {
    for (const seg of run.split(/[的了和与及或、，,]/)) {
      if (seg.length >= 2 && !STOP_ZH.has(seg)) out.add(seg.slice(0, 12));
    }
  }
  if (out.size < 4) {
    for (const run of cjkRuns) {
      for (let i = 0; i + 2 <= run.length; i++) {
        const bg = run.slice(i, i + 2);
        if (!STOP_ZH.has(bg)) out.add(bg);
      }
    }
  }
  return [...out].filter((t) => t.length >= 2).slice(0, 18);
}

/** 第一轮的面：按查询类型选两个最可能补上信息的面。 */
function facetQueries(query, type) {
  const zh = /[\u4e00-\u9fff]/.test(query);
  if (zh) {
    if (type === "news") return [`${query} 最新进展`, `${query} 对比 评测`];
    if (type === "howto") return [`${query} 原理 机制`, `${query} 报错 失败 坑`];
    return [`${query} 原理 机制`, `${query} 对比 替代方案`];
  }
  if (type === "news") return [`${query} latest news`, `${query} comparison review`];
  if (type === "howto") return [`${query} how it works internals`, `${query} issues errors troubleshooting`];
  return [`${query} explained internals`, `${query} alternatives comparison`];
}

/** 从正文里挑与术语相关的句子当引句。 */
function quotesFrom(text, terms, max = 4) {
  const sentences = text.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/).map((s) => s.trim()).filter((s) => s.length >= 12);
  const scored = [];
  for (const s of sentences) {
    const low = s.toLowerCase();
    const hit = terms.reduce((n, t) => (low.includes(t.toLowerCase()) ? n + 1 : n), 0);
    if (hit > 0) scored.push({ s, hit });
  }
  scored.sort((a, b) => b.hit - a.hit);
  const seen = new Set();
  const out = [];
  for (const { s } of scored) {
    const k = s.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.slice(0, 280));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 多轮深度检索。
 * @param {string} query
 * @param {{rounds?:number, pages?:number, n?:number, maxPerDomain?:number,
 *          minCoverage?:number, recency?:string|null, paid?:number|null,
 *          fetchChars?:number, quoteMax?:number, deadlineMs?:number}} o
 */
export async function deepSearch(query, o = {}) {
  const {
    rounds = 2, pages = 6, n = 20, maxPerDomain = 3, minCoverage = 0.6,
    recency = null, paid = null, fetchChars = 6000, quoteMax = 4, deadlineMs = 8000,
  } = o;
  const det = detectQueryType(query);
  const terms = termsOf(query);
  const signal = o.signal;
  throwIfAborted(signal);
  const trace = [];
  const byUrl = new Map();
  const fetched = new Map();
  let coverage = 0;
  let roundQueries = [query, ...facetQueries(query, det.type)];
  const t0 = Date.now();

  for (let round = 1; round <= rounds; round++) {
    throwIfAborted(signal);
    let res = { results: [] };
    try {
      res = await search(query, {
        n, paid: paid ?? det.paid, recency: recency ?? det.recency, maxPerDomain,
        queries: roundQueries.slice(0, 3), enrich: false, deadlineMs, signal,
      });
    } catch (e) {
      if (e && e.code === "cancelled") throw e;
      trace.push({ round, error: String((e && e.message) || e).slice(0, 120) });
      break;
    }
    let fresh = 0;
    for (const r of res.results || []) {
      const k = canonical(r.url);
      const prev = byUrl.get(k);
      if (prev) { prev.score += r.score; continue; }
      byUrl.set(k, { ...r, firstRound: round });
      fresh += 1;
    }
    const pending = [...byUrl.values()]
      .filter((r) => !fetched.has(canonical(r.url)))
      .sort((a, b) => b.score - a.score)
      .slice(0, pages);
    await Promise.all(pending.map(async (r) => {
      try {
        const f = await fetchText(r.url, fetchChars, signal);
        fetched.set(canonical(r.url), { text: f.text || "", title: f.title, chars: f.chars, status: f.status });
      } catch (e) {
        if (e && e.code === "cancelled") throw e;
        fetched.set(canonical(r.url), { text: "", error: String((e && e.message) || e).slice(0, 80) });
      }
    }));
    const corpus = [...fetched.values()].map((x) => (x.text || "").toLowerCase()).join(" ");
    const found = terms.filter((t) => corpus.includes(t.toLowerCase()));
    coverage = terms.length ? found.length / terms.length : 0;
    const missing = terms.filter((t) => !found.includes(t));
    trace.push({ round, queries: roundQueries.slice(0, 3), newSources: fresh, fetchedTotal: fetched.size, coverage: +coverage.toFixed(2), missing: missing.slice(0, 6) });
    if (coverage >= minCoverage || round === rounds) break;
    const zh = /[\u4e00-\u9fff]/.test(query);
    roundQueries = missing.slice(0, 2).map((t) => (zh ? `${t} 是什么 原理` : `${t} explained`));
    if (!roundQueries.length) break;
  }

  const evidence = [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, pages * 2)
    .map((r) => {
      const f = fetched.get(canonical(r.url));
      return {
        url: r.url, title: r.title || f?.title, published: r.published, providers: r.providers,
        round: r.firstRound, chars: f?.chars ?? 0,
        quotes: f?.text ? quotesFrom(f.text, terms, quoteMax) : [],
      };
    })
    .filter((e) => e.quotes.length > 0 || e.chars > 0);
  const withQuotes = evidence.filter((e) => e.quotes.length > 0);

  return {
    query, type: det.type, terms, rounds: trace.length,
    coverage: +coverage.toFixed(2), trace,
    evidence: withQuotes.length ? withQuotes : evidence,
    totalSources: byUrl.size, elapsedMs: Date.now() - t0,
  };
}

// ── 密钥来源：仓库内 .env（已被 .gitignore 忽略）────────────────────────────
// 一份文件同时喂给 ws MCP 进程（stdio 子进程，自己读）和 DSH 主进程里的
// ws-web provider。cordis 组合里不再出现任何明文密钥，换钥匙只改这一处。
import { dirname as pathDir } from "node:path";
import { fileURLToPath as pathFromUrl } from "node:url";

export const ENV_FILE = pathJoin(pathDir(pathFromUrl(import.meta.url)), ".env");
export const ENV_KEYS = ["EXA_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "SEARXNG_URL"];

/**
 * 解析 KEY=VALUE 形式的 .env 并写入 process.env。
 * @param {string} [file] 默认 process.env.WS_ENV_FILE 或模块同目录的 .env
 * @param {{override?:boolean}} [o] override=true 时文件值覆盖已有环境变量（轮换钥匙用）
 */
export function loadEnvFile(file, o = {}) {
  const envFile = file || process.env.WS_ENV_FILE || ENV_FILE;
  let text;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return { file: envFile, found: false, loaded: [] };
  }
  const loaded = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (!key || value === "") continue;
    if (o.override || process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return { file: envFile, found: true, loaded };
}

/** 只报告四把钥匙在不在，绝不返回值本身。 */
export function envStatus() {
  const on = (k) => Boolean(process.env[k]);
  const keys = { EXA_API_KEY: on("EXA_API_KEY"), TAVILY_API_KEY: on("TAVILY_API_KEY"), BRAVE_API_KEY: on("BRAVE_API_KEY"), SEARXNG_URL: on("SEARXNG_URL") };
  const missing = Object.entries(keys).filter(([, v]) => !v).map(([k]) => k);
  return { ...keys, missing, envFile: process.env.WS_ENV_FILE || ENV_FILE };
}
