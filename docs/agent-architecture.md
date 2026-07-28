# opencode-sandbox Agent 架构设计

> 状态：设计草案（待评审）
> 范围：opencode-sandbox 容器内的 agent 体系、提示词架构、agent 选择机制、会话持久化
> 关联仓库：app-v1（本仓库：sandbox + server）、ai-web（另仓库：聊天 UI）

---

## 1. 背景与目标

opencode-sandbox 是一个跑在 Docker 容器里的 opencode serve 实例，负责为终端用户「用自然语言生成全栈 Web 应用」提供 AI 编码能力。用户在 ai-web 聊天 → opencode 在 sandbox 内改代码 → vite 预览实时刷新 → 满意后 `lightfish publish` 发布。

当前只有一个被覆盖了提示词的 `build` agent，提示词极简（8 行），且 agent 选择机制不完整。本设计要解决：

1. **双 agent 体系**：拆分 `build`（实现）与 `plan`（规划），匹配「先规划后实现」的复杂功能开发流。
2. **业务定制提示词**：参考 Lovable 风格，针对 lightfish 全栈模板做规定性提示词优化。
3. **UI 可选 agent**：用户在 ai-web 里能选 build / plan，选择能透传到 opencode session。
4. **会话持久化**：厘清 opencode.db 的持久化现状与操作纪律，避免重建丢历史。

---

## 2. 现状与关键发现

### 2.1 系统架构现状

```
┌──────────────┐     POST /api/workspaces（建工作区+session+端口）
│   ai-web     │ ────────────────────────────────────┐
│ （浏览器）   │                                      ▼
│              │  聊天/SSE ──────────────► ┌──────────────────┐
│              │  （直连 127.0.0.1:55001） │  sandbox-host    │
└──────────────┘                          │  opencode serve  │
                                          │  :4096           │
        ┌──────────────────┐              │  workspace:/workspace
        │  sandbox-server  │ ──docker exec──► opencode-data:/root/.local/share/opencode
        │  :3060           │              └──────────────────┘
        │  建session/预览/发布│
        └──────────────────┘
```

- **sandbox-host**：opencode serve 监听 4096，对外映射 55001；workspace 与 opencode-data 两个具名卷。
- **sandbox-server**：Hono 服务，建工作区（`lightfish create`）、调 opencode SDK 建 session、分配预览端口、启动 vite、跑 `lightfish publish`。仅 `createSession` 一处碰 SDK，不代理 chat/SSE。
- **ai-web**：浏览器直连 opencode serve 做聊天；也会自行建 session（已发现存在不在 server `sessions.json` 里的 session）。

### 2.2 opencode agent 模型（关键发现）

通过 `/agent` 接口与 SDK 类型（`@opencode-ai/sdk/v2`）确认：

| 内置 agent | mode | native | 说明 |
|---|---|---|---|
| `build` | primary | 是 | **默认 agent**（"The default agent"），主编码执行者 |
| `plan` | primary | 是 | 规划 agent，内置只读（35 条 permission 规则强制） |
| `general` | subagent | 是 | 通用子 agent，不可直接作 session 主 agent |
| `explore` | subagent | 是 | 探索子 agent |

**核心机制：**

- `opencode.json` 的 `agent` 是 `name → AgentConfig` 的 map。覆盖 `agent.{name}.prompt` **只替换系统提示词**，内置 `mode` / `permission` **保留**。
  → 覆盖 `plan.prompt` 后，plan 仍由内置 permission 强制只读，无需手动 `deny edit`。
  → 覆盖 `build.prompt` 后，build 仍是 primary，沿用 opencode.json 的 bash/edit 权限规则。
- 不传 agent 建会话时，opencode 用内置默认 = `build`。这就是当前 session 都是 `agent:"build"` 的原因（server 没传 agent）。
- SDK 三处可指定 agent：
  - `session.create({ directory, agent })` —— 建会话时设定（`sdk.gen.d.ts:978`）
  - `session.promptAsync({ sessionID, agent, parts })` —— 单条消息指定
  - `session.switchAgent({ sessionID, agent })` —— 中途切换
- `Config.default_agent` 可改全局默认（当前未设）。

### 2.3 会话持久化诊断（附）

- `opencode.db` 位于 `/root/.local/share/opencode/`，存全部 session/聊天历史。opencode **不**在 workspace 目录里存数据（已验证）。
- `opencode-data` 具名卷**今天才首次创建**（commit `b3d1551` 才加挂载）。此前 db 在容器临时层，每次 `up -d --build` 重建即丢 → 历史聊天已不可恢复。
- 往后：卷已就位，`docker compose up -d --build` 不删具名卷，**新会话能跨重建存活**。
- **操作纪律**：
  1. 重部署只用 `docker compose up -d --build`，**绝不用 `down -v`**（`-v` 删卷）。
  2. **不改部署目录名**（卷名 = `{项目名}_*`，改名会孤立旧卷）。建议 `.env` 或 compose `name:` 锁死项目名。

---

## 3. 双 Agent 架构设计

### 3.1 职责划分

|  | `build`（实现） | `plan`（规划） |
|---|---|---|
| 角色 | 写代码、跑工具、装依赖、类型检查 | 只读分析、输出可执行蓝图 |
| 做什么 | 按 plan 或直接需求写/改代码，确保 `tsc --noEmit` 通过 | 拆需求、读现有代码、产出结构化方案 |
| 只读强制 | 否（primary） | 是（内置 permission 强制） |
| 何时用 | 直接实现 / 修 bug / 执行 plan 产出 | 复杂功能 / 多文件改动 / 先看方案再动手 |

### 3.2 核心决策：只覆盖 `prompt`

覆盖 `agent.{build,plan}.prompt`，**不**手动设 `mode` / `permission`：

- `plan` 自动维持内置只读强制（不与内置 permission 规则冲突）。
- `build` 保持 primary + opencode.json 已有的 bash/edit 规则。
- 改动面最小，升级 opencode 时内置行为不丢。

### 3.3 协作流程

```
用户提需求
   │
   ├─ 简单/明确 ──► 直接选 build ──► 实现 + tsc + 回报
   │
   └─ 复杂/多文件 ──► 先选 plan ──► 读代码 + 出蓝图
                                      │
                                      ▼ 用户认可
                                   切 build 执行 ──► 实现 + tsc + 回报
```

两者共享同一 workspace 目录与 `AGENTS.md`，上下文连续。

### 3.4 约定单一信源（DRY，关键）

模板自带 `AGENTS.md` 已把全栈约定写得很完整（目录结构、文件路由、状态管理、后端分层、命名、命令）。

**决策：prompt 不复制约定，只指向 + 加硬规则。** agent 运行时读 `AGENTS.md` 获取约定。

好处：模板升级约定时 agent 自动跟上，prompt 不漂移、不重复。

---

## 4. 提示词架构

### 4.1 设计原则（吸收 Lovable + 适配 lightfish）

吸收 Lovable 的：身份+技术栈锚定、硬规则、工作流、效率（并行工具）、设计系统、反模式、讨论优先。

适配点见 4.4 对照表。

### 4.2 `prompts/build.txt` 结构

章节：技术栈 → 交互原则 → 约定信源(DRY) → 硬规则 → 工作流 → 效率 → 设计系统(Tailwind 4 CSS-first) → 全栈协作 → 调试 → 代码风格 → 反模式。

### 4.3 `prompts/plan.txt` 结构

章节：技术栈 → 约定信源 → 硬规则(只读) → 工作流 → 输出格式(7 段) → 目标。复杂架构用 mermaid。

### 4.4 Lovable → lightfish 适配对照

| Lovable 原文 | 本设计适配 | 原因 |
|---|---|---|
| 不能跑后端，只接 Supabase | **能且应写** @lightfish/server + Drizzle 后端 | 模板是全栈，后端是一等公民 |
| 设计系统改 `tailwind.config.ts` | 改 `src/main.css` 的 `@theme` | Tailwind 4 CSS-first，无 config 文件 |
| `read-console-logs` / `read-network-requests` 调试 | 读代码 + `tsc --noEmit` + bash | opencode 无这俩工具 |
| 禁用 `VITE_*` 环境变量 | 不禁（模板用 `VITE_BASE_URL`） | Lovable 限制不适用 |
| 约定写进 prompt | **指向 AGENTS.md，不抄**（DRY） | AGENTS.md 已完整，避免漂移 |
| 单 agent（讨论优先） | 拆 build / plan 双 agent | 明确需求 |
| `lov-*` XML 标签、首条消息 wow 等 | 删除 | Lovable 专属 UX，不适用 |

---

## 5. Agent 选择机制（如何用上）

### 5.1 定义（opencode.json）

```jsonc
"agent": {
  "build": { "prompt": "{file:./prompts/build.txt}" },
  "plan":  { "prompt": "{file:./prompts/plan.txt}" }
}
```

Dockerfile 把 `opencode.json` + `prompts/` COPY 进镜像 `/root/.config/opencode/`，故改后需重建 sandbox 镜像。

### 5.2 选择通路（SDK 提供 4 种）

| 机制 | 选择发生处 | 改代码？ | 说明 |
|---|---|---|---|
| `default_agent` | 配置全局默认 | 否 | 顶层加 `"default_agent":"plan"`，所有新 session 默认用它 |
| `session.create({agent})` | 建会话时 | server 透传 | 设定后粘在 session 上，后续 promptAsync 沿用 |
| `session.switchAgent({agent})` | 中途切换 | ai-web | 已有 session 换 agent |
| `promptAsync({agent})` | 单条消息 | 调用方 | 临时指定，不改变 session 默认 |
| `mode:"subagent"` | 主 agent 自动委派 | 否 | 不可直接选，主 agent 经 task 工具调用 |

### 5.3 本方案选型：对话时 switchAgent

**不在建工作区时选 agent**——session 默认 `build`（opencode 内置默认）。用户在 ai-web 聊天界面随时切换：调 `session.switchAgent({ sessionID, agent })`，切换后粘在 session 上，后续轮次沿用。

选型理由：
- 多数会话直接 build，init 强制选 agent 是多余摩擦。
- **server 零改动**（`createSession` 不传 agent，已是现状）。
- 复杂/规划需求：用户切 plan；或 build agent 软引导（prompt 建议切 plan）。
- `switchAgent` 改 session 默认 agent，符合「现在进入规划模式」语义；`session.create({agent})` 透传不再需要。

### 5.4 数据流

```
建工作区（POST /api/workspaces）→ server.createSession(dir) → session.create({ directory })
   session.agent = "build"（默认）

聊天中用户切 plan：
   ai-web → opencode session.switchAgent({ sessionID, agent: "plan" })
   session.agent = "plan"（粘住，后续轮次沿用）

切回 build：
   ai-web → session.switchAgent({ sessionID, agent: "build" })
```
server 全程不碰 agent；切换完全在 ai-web ↔ opencode serve 之间。

---

## 6. 实施方案

### 6.1 本仓库（app-v1）改动

**① `apps/opencode-sandbox/prompts/build.txt`** —— 改写为优化版（实际文件为准）

**② `apps/opencode-sandbox/prompts/plan.txt`** —— 新建（实际文件为准）

**③ `apps/opencode-sandbox/opencode.json`** —— `agent` 加 plan 条目：
```jsonc
"agent": {
  "build": { "prompt": "{file:./prompts/build.txt}" },
  "plan":  { "prompt": "{file:./prompts/plan.txt}" }
}
```

**④ server 零改动** —— `createSession` 不传 agent，session 默认 build。agent 选择交给 ai-web 对话时 `switchAgent`（见 6.2）。

**⑤ 重建 sandbox**（server 无改动，无需重建）：
```bash
docker compose up -d --build opencode-sandbox
```

### 6.2 ai-web 侧改动（另仓库）

完整方案见 **[ai-web-agent-selector.md](./ai-web-agent-selector.md)**。要点：
- 聊天界面放 agent 切换控件；`GET <opencode-base>/agent` 拉列表，过滤 `mode === "primary" && !hidden`。
- 切换调 `session.switchAgent({ sessionID, agent })`；读 session 对象 `agent` 字段显示当前。
- 建工作区不带 agent（`POST /api/workspaces` 不传），session 默认 build。

### 6.3 验证

1. 重建后 `curl http://127.0.0.1:55001/agent`，确认 build/plan 的 prompt 为自定义内容。
2. 建工作区（不带 agent），确认 `session.agent === "build"`。
3. `switchAgent({ agent: "plan" })`，确认 `session.agent === "plan"`，且 plan 下改文件被只读 permission 拦截。
4. `switchAgent({ agent: "build" })` 切回，确认能正常编辑 + `tsc` 通过。

---

## 7. 风险与约束

| 风险 | 说明 | 应对 |
|---|---|---|
| 覆盖 prompt 替换内置 | 覆盖 `build/plan.prompt` 会替换 opencode 内置系统提示词 | 自写 prompt 含完整操作规则；opencode 工具能力不受影响（与 prompt 解耦） |
| ai-web 另仓库 | UI 选择 / switchAgent 改动在 ai-web，本仓库无法覆盖 | 以契约（6.2）对齐，两边联调 |
| agent 切换状态错乱 | switchAgent 改 session 默认 agent，用户可能忘记当前在 plan/build | UI 始终显示当前 agent；切换即时反馈；plan 只读有 permission 兜底 |
| 会话持久化 | `down -v` 或改目录名会丢数据 | 操作纪律（2.3）；建议锁项目名 |
| 模板约定演进 | AGENTS.md 变更会影响 agent 行为 | DRY 设计本就为此；prompt 不抄约定，自动跟 |

---

## 8. 自定义工具体系

opencode 扩展工具能力分两套独立机制，各有一份文档：

- 👉 **[custom-tools.md](./custom-tools.md)** — Custom Tools：TS 文件定义、opencode 进程内运行。含一个 `example` 示例工具（仅供参考，未接入）。
- 👉 **[mcp.md](./mcp.md)** — MCP Servers：独立进程 / 远程服务，连外部服务、DB、第三方 API。

要点：Custom Tools 源码在 `apps/opencode-sandbox/tools/`，Dockerfile 已 `COPY tools/`，`@opencode-ai/plugin` 全局已装；进程内操文件用它，连外部用 MCP。

---

## 9. 附录

### A. 提示词

提示词以实际文件为准（持续迭代，不再在此重复内容，避免脱节）：

- `apps/opencode-sandbox/prompts/build.txt` —— build（实现）agent 提示词
- `apps/opencode-sandbox/prompts/plan.txt` —— plan（规划）agent 提示词

设计要点见正文第 3、4 节（双 agent 职责、提示词架构、Lovable 适配）。

### B. AgentConfig 字段（可用）

`model` / `variant` / `temperature` / `top_p` / `prompt` / `tools`（map: 工具名→bool）/ `disable` / `description` / `mode`（subagent|primary|all）/ `hidden` / `color` / `steps` / `maxSteps` / `permission` / `options`。

### C. SDK 方法签名（`@opencode-ai/sdk/v2`）

```ts
session.create({ directory?, agent?, model?, title?, metadata?, permission?, ... })
session.promptAsync({ sessionID, agent?, model?, parts?, tools?, system?, ... })
session.switchAgent({ sessionID, agent? })
```

### D. 关键文件路径

| 路径 | 作用 |
|---|---|
| `apps/opencode-sandbox/opencode.json` | agent 定义、provider、permission |
| `apps/opencode-sandbox/prompts/*.txt` | agent 提示词（COPY 进镜像 `/root/.config/opencode/`） |
| `apps/opencode-sandbox/Dockerfile` | 构建 sandbox 镜像 |
| `apps/server/src/opencode.ts` | `createSession` / `sendPrompt` / `deleteSession` |
| `apps/server/src/routes.ts` | `POST /api/workspaces` 等接口 |
| `docker-compose.yml` | sandbox + server 编排、卷挂载 |
| 容器内 `/root/.local/share/opencode/opencode.db` | session/聊天历史（opencode-data 卷） |
| 容器内 `/root/.config/opencode/` | opencode.json + prompts + 全局插件 |
| workspace 模板 `AGENTS.md` | 全栈约定唯一信源 |

### E. 模板技术栈（lightfish create 生成）

React 19 · Vite 8 · TypeScript 6 · Tailwind 4（CSS-first）· @lightfish/router（文件系统路由）· @lightfish/react-model · @lightfish/server + Drizzle ORM + PostgreSQL · ESLint 10 · `@` → `./src`
