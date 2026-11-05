#!/usr/bin/env node
// ws-mcp — 把 ws 检索网关暴露为 MCP server（stdio, JSON-RPC 2.0, 按行分隔）
import { createInterface } from "node:readline";
import { search, fetchText, tavilyExtract, tavilyCrawl, tavilyMap, tavilyResearch, exaAgent, cacheStats } from "./lib.mjs";

const TOOLS = [
  {
    name: "ws_search",
    description: "聚合搜索：并行 Exa（语义）+ Tavily（结构化）+ Brave（自有 API）+ SearXNG（自托管、免费），按 canonical URL 去重后 RRF 融合。默认只花 1 个付费源，SearXNG 始终参与；单源失败自动降级。结果带 providers 归属与 cached 标记。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词或自然语言描述" },
        n: { type: "integer", default: 10, description: "返回条数" },
        paid: { type: "integer", default: 1, description: "允许的付费源个数（0-3，候选顺序 exa>tavily>brave）" },
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
];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const HANDLERS = {
  ws_search: (a) => search(a.query, { n: a.n ?? 10, paid: a.paid ?? 1 }),
  ws_fetch: (a) => (Array.isArray(a.urls) && a.urls.length
    ? tavilyExtract(a.urls, { depth: a.depth ?? "basic" })
    : fetchText(a.url, a.max ?? 3000)),
  ws_map: (a) => tavilyMap(a.url, { limit: a.limit ?? 50, maxDepth: a.max_depth ?? 2 }),
  ws_crawl: (a) => tavilyCrawl(a.url, { limit: a.limit ?? 20, maxDepth: a.max_depth ?? 1, instructions: a.instructions }),
  ws_research: (a) => tavilyResearch(a.input, { model: a.model ?? "auto" }),
  ws_agent: (a) => exaAgent(a.query, { effort: a.effort ?? "auto" }),
};

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "ws", version: "0.2.0" },
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
