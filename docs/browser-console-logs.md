# 浏览器运行时日志捕获（设计草案，未实现）

> 状态：**未实现**，设计备查。对标 Lovable `read-console-logs` / `read-network-requests`。
> 关联：第一层 vite 编译日志已实现（`tools/dev_log.ts`）；本文是第二层运行时日志的设计。
> 关联：`docs/custom-tools.md`、`docs/agent-architecture.md`

---

## 1. 背景与目标

第一层 `dev_log` 只覆盖 **vite 终端日志**（编译错误、HMR 事件）。但**运行时错误**——React render 崩溃、`console.error`、未捕获的 Promise rejection、网络请求失败——发生在**浏览器**里，agent 完全看不到。

Lovable 的 `read-console-logs` 能看到浏览器控制台，是因为它在预览页注入了捕获脚本，把控制台日志回传给后端。本文设计同等能力，让 agent 能排查运行时问题。

---

## 2. 整体架构

```
预览页(浏览器)                          sandbox-server
┌─────────────────────┐                ┌──────────────────────┐
│ 捕获脚本(注入)       │  POST /console  │ 接收端点             │
│  console.error/warn  │ ──────────────► │  追加到              │
│  window.onerror      │                │  /tmp/console-x.log  │
│  unhandledrejection  │                └──────────────────────┘
└─────────────────────┘                          ▲
        ▲                                        │ tail
        │ 注入(transformIndexHtml)               │
        │                                        │
   vite dev server                        opencode agent
   (server 启动时写 overlay 配置)          调 console_log 工具 / dev_log 扩展
```

四块：捕获脚本、注入方式、接收端点、agent 读取。

---

## 3. 详细设计

### 3.1 捕获脚本

注入到预览页 `<head>` 的一段 JS，hook 浏览器侧错误与日志：

- `console.error` / `console.warn` / `console.log`（按级别采，error/warn 优先）
- `window.onerror`（同步异常）
- `window.addEventListener('unhandledrejection', …)`（Promise 未捕获）
- 可选：`fetch` / `XMLHttpRequest` wrap（网络请求捕获，对标 `read-network-requests`）

采集后**节流批量 POST** 到 server（如每 500ms 或满 10 条），避免高频请求。payload：`{ sessionID, level, message, stack?, source?, ts }`。

脚本要轻量、无依赖、CORS 友好（POST 到 server 域，server 放行该来源）。

### 3.2 注入方式（关键：模板不改）

server 启 vite 时，在 workspace 写一个 overlay 配置，用 `transformIndexHtml` 把捕获脚本注入 `<head>`：

1. server 在 `${dirOf(appId)}/vite.dev.config.ts` 写入：
   ```ts
   import base from "./vite.config.ts";
   import { defineConfig, mergeConfig } from "vite";
   export default defineConfig((env) =>
     mergeConfig(typeof base === "function" ? base(env) : base, {
       plugins: [{
         name: "lf-console-capture",
         transformIndexHtml(html) {
           return html.replace("<head>", `<head><script>${CAPTURE_SCRIPT}</script>`);
         },
       }],
     }),
   );
   ```
2. `startVite` 改为 `pnpm exec vite --config vite.dev.config.ts --port …`。
3. 捕获脚本 + overlay 配置可由 server 生成（写在 `/opt/devtools/` 然后软链/拷进 workspace，或直接内联生成）。

好处：**lightfish create 模板完全不动**，全部在 server 侧（本仓库）。

### 3.3 接收端点

server（Hono）加：

- `POST /api/workspaces/:sessionId/console`：body 是日志条目数组；按 sessionId → appId，追加到 `/tmp/console-${appId}.log`（每行一条 JSON）。
- CORS 放行预览来源（preview 域）。
- 日志体积控制：环形缓冲 / 按条数截断（如只留最近 500 条），避免无限增长。

### 3.4 agent 读取

两种选择：

- **扩展 `dev_log`**：`dev_log` 同时返回 vite 日志 + console 日志（分两段）。一个工具看全部。
- **新建 `console_log` 工具**：独立工具，与 `dev_log` 分开。职责更清晰。

推荐扩展 `dev_log`（agent 一个工具看全），加 `source` 参数区分（`vite` / `console` / `all`）。

### 3.5 build.txt 提示词

调试节加：「运行时错误（React 崩溃、console.error）调 `dev_log`（source=console）看浏览器控制台日志。」

---

## 4. 取舍与风险

| 项 | 说明 | 应对 |
|---|---|---|
| 跨域 | 捕获脚本 POST 到 server，预览域 ≠ server 域 | server CORS 放行预览来源；或经 vite 代理同源 |
| 性能 | 高频日志刷爆 server | 节流批量 POST（500ms / 10 条一批） |
| 隐私 | 日志可能含敏感数据（token、用户输入） | 过滤 Authorization 头、敏感 key；或仅 error 级 |
| 体积 | 长会话日志无限增长 | 环形缓冲 / 最近 N 条截断 |
| 注入可靠性 | overlay 配置与模板 vite.config 兼容性 | mergeConfig 合并；模板升级时回归测试 |
| 跨域 iframe | ai-web 嵌入预览 iframe，控制台仍不可直读 | 本方案不依赖 iframe 跨域，脚本在预览页内自行 POST |

---

## 5. 与第一层的关系

| 层 | 覆盖 | 状态 | 工具 |
|---|---|---|---|
| 第一层 | vite 编译日志（编译错误、HMR） | ✅ 已实现 | `dev_log`（读 `/tmp/vite-<appId>.log`） |
| 第二层 | 浏览器运行时日志（React 崩溃、console、网络） | ⏳ 本草案 | 扩展 `dev_log` 或新建 `console_log` |

第一层已能排查大部分编译期问题；第二层补齐运行时排查，达到 v0/Lovable 体验。

---

## 6. 进一步：网络请求捕获

在捕获脚本里 wrap `fetch` / `XMLHttpRequest`，记录 url/method/status/duration，POST 到 `POST /api/workspaces/:sessionId/network`，落 `/tmp/network-<appId>.log`。对标 Lovable `read-network-requests`。可与第二层同批做，或单独迭代。

---

## 7. 实施清单（待启动）

1. server 写 `vite.dev.config.ts` overlay + 捕获脚本生成（`apps/server/src/`）。
2. `startVite` 改用 `--config`。
3. server 加 `POST /api/workspaces/:sessionId/console` + 持久化 + 截断。
4. CORS 放行预览域。
5. 扩展 `dev_log`（加 `source` 参数）或新建 `console_log` 工具。
6. build.txt 调试节更新。
7. 验证：人为触发 React 报错，确认 agent 能读到。
