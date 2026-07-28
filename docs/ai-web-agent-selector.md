# ai-web 修改文档：对话时切换 Agent

> 范围：ai-web 前端（另仓库）需做的改动，让用户在聊天界面随时切换 build / plan agent。
> 关联：`docs/agent-architecture.md` 第 5、6 节（机制与选型）。
> 现状：本仓库（app-v1）server **零改动**——`createSession` 不传 agent，session 默认 build。切换完全在 ai-web ↔ opencode serve 之间完成。

---

## 1. 目标

- 工作区创建时**不选 agent**，session 默认 `build`。
- 聊天界面提供一个 **agent 切换控件**，用户随时切到 `plan`（规划/只读）或切回 `build`（实现）。
- 切换通过 opencode SDK 的 `session.switchAgent` 完成，切换后粘在 session 上，后续轮次沿用。

为什么不在创建时选：多数会话直接 build，强制选是多余摩擦；复杂/规划需求随时切即可。

---

## 2. 涉及的 opencode 接口

ai-web 已直连 opencode serve 做聊天，复用同一连接。

| 接口 | 作用 | 备注 |
|---|---|---|
| `GET <oc-base>/agent` | 拉可用 agent 列表 | 返回 `name`/`mode`/`native`/`hidden`/`description`/`permission` |
| `session.switchAgent({ sessionID, agent })` | 切换当前 session 的 agent | 切后粘住，后续轮次沿用 |
| session 对象的 `agent` 字段 | 当前 agent | 用于显示当前选中 |

- `oc-base`：dev `http://localhost:55001`，prod `https://oc.${PUBLIC_DOMAIN}`（CORS 已开）。
- 列表过滤：`mode === "primary" && !hidden`。当前会得到 `build`、`plan`（两者都 primary、native、非 hidden）。
- `plan` 只读由 opencode 内置 permission 强制（前端无需校验，切到 plan 后 opencode 会拒编辑）。

---

## 3. UI 设计

### 3.1 控件位置

聊天界面顶部工具栏（或输入框上方）放一个 agent 切换控件。建议**分段控件（segmented）或下拉**，二选一即可（当前只有 build/plan）：

```
┌─────────────────────────────────────┐
│ [build] [plan]      ← 当前 build 高亮 │
├─────────────────────────────────────┤
│  聊天消息区                          │
│  ...                                │
├─────────────────────────────────────┤
│  输入框                      [发送]  │
└─────────────────────────────────────┘
```

### 3.2 显示规则

- 当前 agent 从 session 对象的 `agent` 字段读，高亮对应项。
- 每个 agent 附一句说明：`build` = 实现（写代码）/ `plan` = 规划（只读分析）。可从 `/agent` 的 `description` 取，或前端硬编码这两句。
- 切换中（请求未返回）控件 disabled，防重复点。

### 3.3 交互

1. 用户点 `plan` → 调 `session.switchAgent({ sessionID, agent: "plan" })`。
2. 成功 → 更新高亮到 `plan`，可 toast「已切换到规划模式（只读）」。
3. 失败 → toast 报错，高亮回退原选中。
4. 后续发消息走 plan agent；切回 `build` 同理。

---

## 4. 实现要点

### 4.1 拉列表

```ts
// 一次拉取，缓存；构建时也可硬编码 [build, plan] 兜底
const agents = (await fetch(`${ocBase}/agent`).then(r => r.json()))
  .filter(a => a.mode === "primary" && !a.hidden);
// → [{ name: "build", description: "The default agent..." }, { name: "plan", ... }]
```

### 4.2 切换

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const client = createOpencodeClient({ baseUrl: ocBase, directory });
await client.session.switchAgent({ sessionID, agent: "plan" });
// 成功后 session.agent === "plan"
```

### 4.3 当前 agent 来源

- 建 workspace 后 server 返回 `sessionId`；ai-web 用 `session.get` 或订阅 session 更新拿 `agent` 字段。
- 切换成功后本地立即更新，不必等下次拉取。

### 4.4 状态归属

- agent 是 **per-session** 的：每个 workspace/session 各自维护当前 agent。切换只影响当前 session，不污染其他。
- 刷新页面/重进：从 session 对象重读 `agent` 恢复高亮。

---

## 5. 边界与注意

| 场景 | 处理 |
|---|---|
| `/agent` 拉取失败 | 兜底硬编码 `[{name:"build"},{name:"plan"}]`，或 toast 提示重试 |
| `switchAgent` 失败 | toast 报错，控件回退原选中，不发消息 |
| 切到 plan 后用户让改代码 | opencode 会拒（permission）；前端可提示「plan 只读，请切回 build」 |
| 切换时正在生成 | 建议生成中禁用切换，或切换前 confirm |
| 历史消息 | 同一 session 历史共享；切 agent 只改后续轮次的系统提示词，历史不变 |
| 只有一个 agent | 控件可隐藏（未来若禁用 plan） |

---

## 6. 不需要做的

- **不改 server**：`POST /api/workspaces` 不加 `agent` 参数，`createSession` 不传 agent。
- **不做 init 选择 UI**：建工作区流程不出现 agent 选择。
- **不自己校验 plan 只读**：由 opencode permission 兜底。

---

## 7. 验证

1. 建工作区 → 控件显示 `build`，发「做个待办」能正常生成代码。
2. 点 `plan` → 高亮切到 `plan`，发「规划登录页」→ 返回蓝图、不让改文件（被拒）。
3. 点 `build` → 切回，发「按上面规划实现」→ 正常编辑 + tsc。
4. 刷新页面 → 控件高亮恢复到上次切换的 agent。
5. 两个 workspace 并行 → 各自 agent 独立，互不影响。

---

## 8. 后续可选

- **软引导**：build agent prompt 已可加「复杂/规划需求建议用户切 plan」（本仓库 build.txt 控制），ai-web 无需配合。
- **`default_agent` 配置**：若想某环境默认 plan，opencode.json 顶层加 `"default_agent": "plan"`（当前不设 = 默认 build）。
- **更多 agent**：未来加新 primary agent，控件自动从 `/agent` 列出，无需前端改。
