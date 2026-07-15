# init SSE 接入文档

## 端点

```
GET /api/workspaces/{sessionId}/init
Content-Type: text/event-stream
```

- `200`：SSE 流。
- `404`：store 无此 sessionId（workspace 不存在 / 已被删除）。
- `400`：sessionId 格式非法。

`sessionId` 由 `POST /api/workspaces` 创建工作区时返回（opencode 的 session id，形如 `ses_xxx`）。

## 事件协议

每个事件格式：

```
event: <name>
data: <json>

```

事件序列：

1. **`init`** `{sessionId, directory, port, previewUrl}`
   连接后首事件，含 workspace 全部信息。前端可用 `directory` 建 opencode client、用 `previewUrl` 挂预览 iframe。

2. 安装阶段（`node_modules` 不存在时）：
   - `install.start` `{}`
   - `install.log` `{stream:"stdout"|"stderr", text}` × N（实时日志）
   - `install.done` `{exitCode}`
   - 已存在则发 `install.skip` `{reason:"node_modules exists"}`
   - `exitCode !== 0` → 发 `error` `{phase:"install", message}` 并结束

3. 启动 vite 阶段（端口未监听时）：
   - `serve.start` `{}`
   - `serve.log` `{text}` × N（vite 启动日志，含 `VITE vX ready in X ms`）
   - 已在监听则发 `serve.skip` `{reason:"already running"}`
   - 60s 未就绪 → 发 `error` `{phase:"serve", message:"vite did not become ready (timeout)"}` 并结束

4. **`ready`** `{previewUrl, port}`
   预览就绪，流结束。

5. **`error`** `{phase:"install"|"serve"|"unknown", message}`
   任意阶段失败，流结束。

## 幂等

重连安全：`node_modules` 在 → `install.skip`；vite 在 → `serve.skip`；直奔 `ready`。
前端刷新 / 恢复时直接重连本端点即可拿回 `directory` + `port`。

## 客户端示例（EventSource）

```js
const es = new EventSource(`/api/workspaces/${sessionId}/init`);

es.addEventListener("init", (e) => {
  const { directory, port, previewUrl } = JSON.parse(e.data);
  setupOpencode(directory); // 用 directory 建 opencode client
});

es.addEventListener("install.log", (e) => {
  appendLog(JSON.parse(e.data).text);
});

es.addEventListener("serve.log", (e) => {
  appendLog(JSON.parse(e.data).text);
});

es.addEventListener("ready", (e) => {
  const { previewUrl } = JSON.parse(e.data);
  showPreview(previewUrl); // 挂 iframe
  es.close();
});

es.addEventListener("error", (e) => {
  // 注意区分：HTTP 404/400 时 e.data 为 undefined（连接级错误）；
  // 业务 error 事件时 e.data 是 {phase, message} 的 JSON。
  if (e.data) onError(JSON.parse(e.data));
  es.close();
});
```

## 工作区生命周期

```
POST /api/workspaces
  → {sessionId, directory, previewPort, previewUrl}

GET /api/workspaces/{sessionId}/init   (SSE)
  → init{...} → install → serve → ready{previewUrl, port}
  → 用 previewUrl 挂 iframe 预览

POST /api/workspaces/{sessionId}/stop
  → {stopped: <bool>}        // 停 vite 释放内存，保留工作区，再 init 会自动重启

DELETE /api/workspaces/{sessionId}
  → {ok: true}                // 彻底删：停 vite + 删目录 + 删 opencode session + 删映射

GET /api/health
  → {ok: true|false}
```

## 备注

- `serveUrl`（opencode serve 地址）由前端自维护，本服务不返回。
- 预览端口池 5174-5199（26 个），`POST` 时扫最低空闲分配；`DELETE` 释放后可复用。
- vite 以 `nohup` 后台常驻于 sandbox 容器，不随 init SSE 断开而停止；`stop` / `DELETE` 才会停。
