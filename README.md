Zero-dependency search gateway: fans one query out to Exa, Tavily, Brave and SearXNG, then dedupes and RRF-merges the results. Ships as an MCP server (`ws-mcp.mjs`) and as a DSH web provider (`ws-web.mjs` + `lib.mjs`).

## 结构

```
lib.mjs      检索后端、RRF 融合、去重、缓存、正文抽取、取消传播（CLI / MCP / DSH 共用）
ws-mcp.mjs   MCP stdio 服务器：ws_search / ws_deep / ws_fetch / ws_map / ws_crawl / ws_research / ws_agent / ws_env
ws.mjs       命令行入口
ws-web.mjs   DSH 的 web provider（在 profile 目录里，不在本仓库）
tests/smoke.mjs  自检：离线断言 + `--live` 联网回归
```

## 检索行为

- **候选池**：DSH 侧先取 `maxResults × poolFactor`（默认 3，夹在 12–50）条做 RRF 融合，再截到 `maxResults`。付费源按请求计费，扩大池子不多花钱。
- **查询类型自动路由**（`detectQueryType`）：navigational / news(recency=week) / comparative(paid=2, enrich) / howto(enrich) / factual(兜底, enrich)。`n` 恒为 25，只有时效、付费档和正文增强随类型变。
- **正文增强**：`enrich` 给前 `enrichTop` 条抓真实正文（本机抓取、免费、有缓存），放进 `content`，DSH 侧映射成 `WebSearchSource.summary`。
- **排序**：RRF 分数 × 权威度权重（wikipedia/arxiv/.edu/.gov ×1.25，docs./github ×1.2，内容农场 ×0.75，quora/reddit ×0.9）；同域默认最多 3 条。
- **缓存**：进程内 LRU + 落盘共享 `~/.dsh/cache/ws-cache.json`（search 5 分钟、fetch 10 分钟、crawl/map 10 分钟）。命中时 `cached: true`、`elapsedMs: 0`。
- **降级**：任一源失败只是把错误记进 `providers[].error`，整体不报错；四源全失败且 0 结果时才抛错，消息里带 `.env` 路径。
- **取消**：`search` / `fetchText` / `deepSearch` 接受 `signal`；已取消立刻抛 `code: "cancelled"`，聚合途中取消不返回半成品也不写缓存。

## 密钥

四把钥匙只存在本目录的 `.env` 里（已被 `.gitignore` 忽略）：

```
EXA_API_KEY=...
TAVILY_API_KEY=...
BRAVE_API_KEY=...
SEARXNG_URL=http://host:8888
```

- `ws-mcp.mjs` 启动时读一次，之后每次 `tools/call` 再读一次（覆盖式），换钥匙不必重启子进程。
- DSH 主进程里的 `ws-web` provider 读同一份文件（组合里只写 `envFile` 路径，不写值）。
- 换路径用环境变量 `WS_ENV_FILE`；`ws_env` 只回报布尔值，不回报密钥内容。

## 与 DSH 的接法

两处消费同一份 `lib.mjs`：

| 入口 | 挂在哪 | 谁读 |
|---|---|---|
| `ws-mcp.mjs` | `~/.dsh/profiles/<name>/cordis.patch.yml` 的 `insert:` → `mcp-ws` | MCP 客户端，提供 `mcp__ws__*` 八个工具 |
| `~/.dsh/profiles/desktop/ws-web.mjs` | 同上，`insert:` → `ws-web` | `ctx.web` 的 `searchProvider: ws` / `fetchProvider: ws`，让 `web_search` / `web_fetch` 走本网关 |

两个坑：

1. **MCP 条目必须写在 `- insert:` 列表里**。顶层 `- id: mcp-ws` + `name` 是"覆盖已有条目"，基础组合里没有这个 id，patch 层会静默丢弃，MCP 永远不启动。
2. `command` 要绝对路径（`C:/Program Files/nodejs/node.exe`），ACP 路径校验 `isAbsolute`；再配 `failOnStartupError: true`，启动失败才会报出来而不是静默禁用工具。

`ws-web.mjs` 按 `lib.mjs` 的 mtime 给 import URL 加版本串，所以改完 `lib.mjs` 由 loader 热重载即刻生效，不用重启 DSH。

## 自检

```bash
node tests/smoke.mjs          # 离线：canonical / rrf / 类型路由 / 取消 / envStatus
node tests/smoke.mjs --live   # 联网：五种类型真打，校验去重、同域上限、正文增强、取消
```
