# v1-web Listener 泄漏修复方案

> 范围：ai-web（`/Users/lightfish/Project/v1-web`）侧修复 `MaxListenersExceededWarning` 事件监听器泄漏。
> 关联：`docs/agent-architecture.md`（sandbox 架构）、opencode v1.18.1。
> 状态：方案待评审，未实现。

---

## 1. 现象

opencode-sandbox 容器日志反复出现：
```
MaxListenersExceededWarning: Possible EventTarget memory leak detected.
11 event listeners added to [yZ]. MaxListeners is undefined.
  at ~effect/Effect/evaluate ... runLoop ... runTasks ... afterScheduled
```
- 跑一段时间 / 在 ai-web 页面**切换（尤其 home ↔ chat 来回）**后出现。
- `yZ` 是 opencode 服务端内部 EventTarget；listener 堆到 11 触发告警。
- 严重时 CPU 飙高（曾观测 119%）、体感卡顿。

## 2. 根因（证据链）

1. `src/pages/chat/[sessionId]/index.tsx`：`<RuntimeProvider sessionId={sessionId}>` 在 ChatPage 内调用 `useOpenCodeRuntime`。
2. `useOpenCodeRuntime`（`@assistant-ui/react-opencode`）内部 `registry = useMemo(() => createRegistry(client), [client])`，registry 持有唯一的 `OpenCodeEventSource`，它开**一条 SSE** 到 opencode（`client.event.subscribe`）。
3. `chat-header.tsx`：`navigate("/")` 回首页 → **ChatPage unmount** → `registry.dispose()` → SSE `abortController.abort()`（中断 SSE）。
4. 再进 `/chat/x` → **ChatPage remount** → 重建 registry → **开新 SSE**。
5. opencode 在旧 SSE 被中断时，**没移除服务端 `yZ` 上的 listener** → 每来回 +1，11 次触发告警。

> 注：纯同路由切 session（`navigate("/chat/B")` from `/chat/A`）**不 remount** → 不重建 SSE → 不漏。**只有 home ↔ chat 这种跨路由来回（unmount/remount）才漏。**

**结论**：触发在 v1-web（remount 重建 SSE），根因在 opencode（SSE 断开不清服务端 listener）。两边都能治。

---

## 3. 修复方案

| 方案 | 做法 | 效果 | 成本 |
|---|---|---|---|
| **A. opencode 升级（根治，先试）** | v1.18.1 → 最新 | 修服务端 SSE 断开的 listener 清理 | 低（改 Dockerfile 版本号 + 重建） |
| **B. v1-web 把 runtime 提到根 layout（确定）** | `useOpenCodeRuntime` 从 ChatPage 提到根 layout，不随路由 remount | home↔chat 不重开 SSE，从源头不触发 | 中（改 layout + chat 页） |
| C. 兜底 | `setMaxListeners` 消警告 / 定期 restart sandbox | 压症状不治本 | 低 |

**建议**：先试 A（最省事）；若升级后仍漏或不能升级，做 B（不依赖 opencode，确定见效）。C 仅作临时兜底。

---

## 4. 方案 B 具体改法

核心：让 `useOpenCodeRuntime`（及其 registry/eventSource/SSE）的**生命周期脱离 ChatPage**，提到根 layout。home ↔ chat 切换只换 `<Outlet/>`，runtime 不 unmount → SSE 不重建。

> `@lightfish/router` 文件路由：`src/pages/layout.tsx` 会被当作根 layout 包裹所有路由（`main.tsx` 的 `layouts` glob 已含 `**/layout.tsx`）。

### 4.1 新增根 layout `src/pages/layout.tsx`

```tsx
import { Outlet } from "react-router-dom";
import { useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { createOpencodeClient, useOpenCodeRuntime } from "@assistant-ui/react-opencode";
import { OpenCodeClientContext } from "@/components/opencode/client-context";
import { OPENCODE_BASE_URL } from "@/pages/constant";

export default function RootLayout() {
  // 全局唯一 client + runtime：不随路由切换重建 → SSE 常驻一条
  const client = useMemo(
    () => createOpencodeClient({ baseUrl: OPENCODE_BASE_URL }),
    [],
  );
  const runtime = useOpenCodeRuntime({ client });

  return (
    <OpenCodeClientContext.Provider value={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Outlet />
      </AssistantRuntimeProvider>
    </OpenCodeClientContext.Provider>
  );
}
```

### 4.2 改造 `src/pages/chat/[sessionId]/`

- **`index.tsx`**：去掉 `<RuntimeProvider>` 包裹。runtime 现在来自根 layout 的 context，ChatPage 只负责"把当前路由的 sessionId 设为活跃 thread"。
  ```tsx
  // 用路由 sessionId 切活跃 thread（不重建 runtime）
  const { sessionId } = useParams();
  // 调 assistant-ui 的 thread list API 切到 sessionId（见 4.4）
  ```
- **`RuntimeProvider.tsx`**：删除（或保留仅放 `AgentContext`，见 4.3）。`useOpenCodeRuntime` / `AssistantRuntimeProvider` / `OpenCodeClientContext.Provider` 都移到根 layout，不再在此创建。

### 4.3 agent 状态

现有 `RuntimeProvider.tsx` 还持有 `AgentContext`（agent + setAgent，给 `agent-switcher.tsx` 用）+ 启动时 `session.get` 读 `agent` 恢复高亮。

- 把 `AgentContext` 提到根 layout（或独立 `AgentProvider`），随 runtime 一起全局化。
- `session.get({ sessionID })` 读 agent：改为在"切活跃 thread"时按当前 sessionId 拉一次，更新 agent state。

### 4.4 thread 切换（关键，别再靠 remount）

之前靠 `initialSessionId={sessionId}` + remount 来切 session。runtime 全局化后，改用 assistant-ui 的 **thread list runtime** API 切活跃 thread：

- `useOpenCodeRuntime` 内部用 `useRemoteThreadListRuntime`，暴露 thread list。
- 路由 `sessionId` 变化时，调 runtime 的 `setActiveThreadId(sessionId)`（或等价 API）切线程，**不重建 runtime、不重开 SSE**。
- `onThreadIdChange` 回调里做 `navigate(\`/chat/${id}\`)`，保证 UI 与路由同步。

> 具体 API 名以 `@assistant-ui/react` 版本为准（`useExternalStoreRuntime`/`useRemoteThreadListRuntime` 的 thread list 接口）。这一步是把"路由驱动 remount"改成"路由驱动 setActiveThread"，是本次重构的核心点。

### 4.5 工作区 init SSE（无需改）

`src/pages/chat/[sessionId]/model.ts` 的 `useWorkspace` EventSource（`/api/workspaces/:sid/init`）已有正确 `es.close()` + `useEffect` cleanup，**不在泄漏路径**，保持不动。

---

## 5. 验证

1. 改完后 `pnpm dev` 起 v1-web，开浏览器到 `/chat/A`。
2. 反复 home ↔ chat 来回 **20 次**（之前 ~11 次就触发）。
3. 同时 `docker logs sandbox-host -f`，确认**不再出现** `MaxListenersExceededWarning`。
4. `docker exec sandbox-host sh -c 'lsof -i :4096 -nP | grep -c ESTABLISHED'`：来回切换过程中**保持 1 条** SSE（不再随切换增长）。
5. 切不同 session 发消息，确认聊天正常、agent 切换正常。

---

## 6. 备注 / 风险

- **方案 A（升级 opencode）优先试**：若新版本修了 SSE 断开清理，零 v1-web 改动即解决。先升级复测，仍漏再做 B。
- **方案 B 是重构**：把 runtime 从"每页一个"改成"全局一个 + thread list 切换"。注意 assistant-ui 版本 API 差异；thread 切换逻辑要测透（切回旧 session 历史/状态正确）。
- **不破坏同路由切 session**：纯 `/chat/A → /chat/B` 本就不漏，B 方案后行为一致。
- **兜底**：在 A/B 都落地前，可临时在 sandbox 加 healthcheck（CPU 持续高自动 restart）或每日定时 `docker compose restart opencode-sandbox`，避免长跑堆积。会话历史不丢（opencode-data 卷）。
