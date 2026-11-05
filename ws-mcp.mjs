#!/usr/bin/env node
// ws-mcp — 把 ws 检索网关暴露为 MCP server（stdio, JSON-RPC 2.0, 按行分隔）
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// lib.mjs 按 mtime 热加载：改完检索逻辑，下一次 tools/call 就生效，不用重启子进程
// （DSH 的 profile provider 用同一套做法，两边共用同一份 lib.mjs）。
const LIB_PATH = join(dirname(fileURLToPath(import.meta.url)), "lib.mjs");
let libCache = { v: null, mod: null };
async function getLib() {
  let v = "0";
  try { v = String(Math.trunc(statSync(LIB_PATH).mtimeMs)); } catch {}
  if (libCache.v !== v) libCache = { v, mod: await import(`${pathToFileURL(LIB_PATH).href}?v=${v}`) };
  return libCache.mod;
}

// 密钥来源：模块同目录的 .env（或 WS_ENV_FILE 指定的路径）。启动读一次，
// 之后每次调用再读一次（override），这样换钥匙不必重启 MCP 子进程。
const boot = await getLib();
const envBoot = boot.loadEnvFile(undefined, { override: true });
if (!envBoot.found) process.stderr.write(`ws-mcp: ${boot.ENV_FILE} not found; relying on inherited environment\n`);

const TOOLS = [
  {
    name: "ws_search",
    description: "聚合搜索：并行 Exa（语义）+ Tavily（结构化）+ Brave（自有 API）+ SearXNG（自托管、免费），按 canonical URL 去重后 RRF 融合。默认只花 1 个付费源，SearXNG 始终参与；单源失败自动降级。结果带 providers 归属与 cached 标记。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词或自然语言描述" },
        n: { type: "integer", default: 25, description: "返回条数；前 5 条给完整摘要(400字)，其余截断到 240 字" },
        paid: { type: "integer", default: 1, description: "允许的付费源个数（0-3）。顺序自动按语言选：中文 tavily>brave>exa，其余 exa>brave>tavily" },
        recency: { type: "string", enum: ["day", "week", "month", "year"], description: "只要这段时间内的结果（新闻类查询必用）" },
        max_per_domain: { type: "integer", default: 3, description: "同一域名最多保留几条（提高来源广度，0=不限）" },
        queries: { type: "array", items: { type: "string" }, description: "多查询扩展：给 2-3 种不同措辞，结果合并去重后可显著提高召回（每个 query 都会独立计费）" },
        enrich: { type: "boolean", description: "是否给前 3 条附上真实正文（默认按查询类型自动决定；正文取自本机抓取，免费）" },
      },
      required: ["query"],
    },
  },
  {
    name: "ws_fetch",
    description: "读取网页正文。单个 URL 用本地抓取（免费、快）；传 urls 数组时走 Tavily extract（能过 JS 渲染与反爬）。已知 URL 优先用本工具，不要先搜。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "单个 URL" },
        urls: { type: "array", items: { type: "string" }, description: "多个 URL（走 Tavily extract）" },
        max: { type: "integer", default: 3000, description: "单页正文上限字符数" },
        depth: { type: "string", enum: ["basic", "advanced"], default: "basic", description: "extract 深度" },
      },
    },
  },
  {
    name: "ws_map",
    description: "站点地图：给一个域名/URL，列出该站可访问的页面链接（Tavily map）。适合先摸清文档站结构再挑页面读。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "根 URL" },
        limit: { type: "integer", default: 50 },
        max_depth: { type: "integer", default: 2 },
      },
      required: ["url"],
    },
  },
  {
    name: "ws_crawl",
    description: "站点爬取：按深度/广度抓取多个页面并返回正文（Tavily crawl）。适合把一个小型文档站整体读进来。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "起始 URL" },
        limit: { type: "integer", default: 20, description: "最多抓取页数" },
        max_depth: { type: "integer", default: 1 },
        instructions: { type: "string", description: "自然语言指令，限定要抓哪类页面" },
      },
      required: ["url"],
    },
  },
  {
    name: "ws_research",
    description: "多步研究（Tavily research，异步，按次计费）：给一个完整问题描述，返回带来源的综合答案。比 ws_search 慢且贵，只在需要跨多页综合时用。",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "完整的研究任务描述" },
        model: { type: "string", enum: ["mini", "pro", "auto"], default: "auto" },
      },
      required: ["input"],
    },
  },
  {
    name: "ws_agent",
    description: "深度研究代理（Exa agent，异步，按次计费）：给一个目标，代理自行多轮检索并产出带引用的长答案。最贵的一档，只在确实需要时用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "研究目标（自然语言）" },
        effort: { type: "string", enum: ["low", "medium", "high", "auto"], default: "auto" },
      },
      required: ["query"],
    },
  },
  {
    name: "ws_deep",
    description: "多轮深度检索：把问题拆成原理/对比/排错几个面并行搜，抓回正文，用问题里的术语量覆盖度，没覆盖够就带着缺口再搜一轮；最后只回带原文引句的证据和覆盖度报告。问题需要准确、有深度、要判断可信度时用它，而不是 ws_search。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搞清的问题（自然语言，写清判据）" },
        rounds: { type: "integer", default: 2, description: "最多几轮（1-4）" },
        pages: { type: "integer", default: 6, description: "每轮回读正文的页数（本机抓取，免费）" },
        min_coverage: { type: "number", default: 0.6, description: "覆盖度达到多少就停（0-1）" },
        recency: { type: "string", enum: ["day", "week", "month", "year"], description: "只要这段时间内的结果" },
        paid: { type: "integer", description: "允许的付费源个数（0-3），默认按查询类型自动" },
      },
      required: ["query"],
    },
  },
  {
    name: "ws_env",
    description: "诊断：报告四把密钥是否加载、.env 路径、缓存条目数。只回布尔值，不回密钥内容。",
    inputSchema: { type: "object", properties: {} },
  },
];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const HANDLERS = {
  ws_search: async (a) => {
    const L = await getLib();
    return L.search(a.query, { n: a.n ?? 25, paid: a.paid, recency: a.recency, maxPerDomain: a.max_per_domain ?? 3, queries: a.queries, enrich: a.enrich });
  },
  ws_fetch: async (a) => {
    const L = await getLib();
    return Array.isArray(a.urls) && a.urls.length
      ? L.tavilyExtract(a.urls, { depth: a.depth ?? "basic" })
      : L.fetchText(a.url, a.max ?? 3000);
  },
  ws_map: async (a) => (await getLib()).tavilyMap(a.url, { limit: a.limit ?? 50, maxDepth: a.max_depth ?? 2 }),
  ws_crawl: async (a) => (await getLib()).tavilyCrawl(a.url, { limit: a.limit ?? 20, maxDepth: a.max_depth ?? 1, instructions: a.instructions }),
  ws_research: async (a) => (await getLib()).tavilyResearch(a.input, { model: a.model ?? "auto" }),
  ws_agent: async (a) => (await getLib()).exaAgent(a.query, { effort: a.effort ?? "auto" }),
  ws_deep: async (a) => {
    const L = await getLib();
    return L.deepSearch(a.query, {
      rounds: Math.min(4, Math.max(1, a.rounds ?? 2)),
      pages: a.pages ?? 6,
      minCoverage: a.min_coverage ?? 0.6,
      recency: a.recency,
      paid: a.paid,
    });
  },
  ws_env: async () => {
    const L = await getLib();
    return { ...L.envStatus(), cache: L.cacheStats(), libVersion: libCache.v };
  },
};

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "ws", version: "0.3.0" },
    } });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const name = params?.name;
    const a = params?.arguments || {};
    try {
      const fn = HANDLERS[name];
      if (!fn) throw new Error("unknown tool: " + name);
      (await getLib()).loadEnvFile(undefined, { override: true });
      const out = await fn(a);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "error: " + (e?.message || e) }] } });
    }
  }
  if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  handle(msg).catch((e) => { if (msg && msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }); });
});
