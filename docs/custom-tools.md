# Custom Tools：自定义工具

> 本文只讲 **Custom Tools**（用 TS 文件定义、opencode 进程内运行的工具）。
> MCP（独立进程、外部服务）是另一套机制，见 **[mcp.md](./mcp.md)**。
> 关联：`docs/agent-architecture.md`（agent 体系）、`apps/opencode-sandbox/tools/`（工具源码）

---

## 1. 是什么

Custom Tools 让你用 **TypeScript 文件** 定义 LLM 可调用的工具，与 opencode 内置工具（`bash`/`read`/`edit`/…）并列。工具在 opencode 进程内执行，能直接读写文件、跑脚本、访问 session 上下文。

本项目把工具源码放 `apps/opencode-sandbox/tools/`，Dockerfile `COPY tools/ /root/.config/opencode/tools/` 烘进镜像，全局生效（所有 workspace 共用）。

**何时用 Custom Tools**：进程内、操本地文件、轻量能力（如本项目 theme 工具）。要连外部服务/DB/第三方 API，用 [MCP](./mcp.md)。

---

## 2. 机制

### 2.1 位置

| 位置 | 作用域 | 本项目 |
|---|---|---|
| `~/.config/opencode/tools/`（容器内 `/root/.config/opencode/tools/`） | 全局，所有 session 共用 | ✅ 用这个 |
| `<project>/.opencode/tools/` | 仅该 workspace | 不用 |

### 2.2 结构：`tool()` helper

```ts
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "工具描述（LLM 据此判断何时调用，写清楚）",
  args: {
    query: tool.schema.string().describe("参数说明"),
  },
  async execute(args, context) {
    // context.directory = session 工作目录（/workspace/app-xxx）
    // context.worktree  = git worktree 根
    // context.agent / sessionID / messageID
    return `结果`;
  },
});
```

- `tool.schema` 就是 [Zod](https://zod.dev)，定义参数类型 + 描述（会变成 LLM 看到的 JSON Schema）。
- `tool()` 本身只是**原样返回输入对象**（`return input`）——它只提供类型提示，不做包装；opencode 读取 `description`/`args`/`execute` 三个字段。
- `execute` 内部可用 `node:fs`、`Bun.$` 调任意语言脚本。

### 2.3 命名规则

| 导出方式 | 工具名 |
|---|---|
| `export default tool({...})` | = 文件名（`database.ts` → `database`） |
| `export const foo = tool({...})` | = `<文件名>_<导出名>`（`math.ts` 导出 `add` → `math_add`） |

一个文件可导出多个工具。自定义工具与内置工具同名时会**覆盖**内置工具（除非有意替换，否则用唯一名）。

### 2.4 ⚠️ `execute` 必须返回字符串

opencode 把工具返回值当作**文本**回传给 LLM（内部会 `.split`/按文本处理）。

- ✅ 返回字符串：`return "结果"` / `return JSON.stringify(obj)`
- ❌ 返回对象/数组：会触发 `undefined is not an object (evaluating 'u.split')` 崩溃

**对象/数组结果用 `JSON.stringify(...)` 包成字符串**。LLM 照样能读 JSON。

### 2.5 权限与 agent 开关

- **默认**：所有工具 enabled + allow，无需配置。
- **全局权限**：opencode.json `permission` 按工具名控 `allow`/`deny`/`ask`，支持通配。
- **按 agent 开关**：`AgentConfig.tools` 是 `工具名 → bool` 的 map，`false` 禁用、`true` 启用、未列 = 默认。

> 自定义工具内部直接 `fs.writeFile` **不走 `edit` 权限**（那是给内置 edit/write 工具的）。要限制自定义工具的写操作，只能用 `AgentConfig.tools: { "工具名": false }` 在该 agent 上禁用它。

### 2.6 前置依赖

容器内 `/root/.config/opencode/package.json` 已声明 `@opencode-ai/plugin`，opencode 启动时自动维护其 `node_modules`。新工具若需第三方依赖，在该 package.json 加依赖并重建镜像（目前工具只用 `node:fs`/`node:path`，无额外依赖）。

---

## 3. 如何添加一个自定义工具

1. **写工具**：在 `apps/opencode-sandbox/tools/` 加 `xxx.ts`（`tool()` + Zod args + `execute`，返回字符串）。
2. **进镜像**：Dockerfile 已 `COPY tools/`（一次性），新文件自动进镜像，无需改 Dockerfile。
3. **权限/开关**（可选）：opencode.json 加 `permission.xxx`，或 agent 的 `tools` 开关。
4. **告知 agent**：在对应 agent prompt 里说明何时用该工具（否则 LLM 不知道该调）。
5. **重建**：`docker compose up -d --build opencode-sandbox`。
6. **验证**：`curl http://127.0.0.1:55001/experimental/tool/ids` 看工具名是否注册。

文件布局：

```
apps/opencode-sandbox/
├── tools/
│   ├── example.ts      ← 示例工具（仅供参考，未接入）
│   └── <新工具>.ts
├── opencode.json       ← 权限 + agent tools 开关
└── Dockerfile          ← COPY tools/（已有）
```

---

## 4. 工具清单

### 4.1 示例工具：example

`tools/example.ts` 是一个最小示例，演示 `tool()` + `args` + `context` + 返回字符串的完整写法。**未被任何 agent prompt 引用**，仅供参考；opencode 会自动注册为 `example` 工具。

```ts
import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

export default tool({
  description: "示例工具：返回当前项目工作目录的基本信息（路径、是否 git 仓库）。",
  args: {},
  async execute(_args, context) {
    const dir = context.directory;
    const isGit = fs.existsSync(path.join(dir, ".git"));
    return JSON.stringify({ directory: dir, git: isGit });
  },
});
```

要点回顾：
- 默认导出 → 工具名 = 文件名 `example`。
- `args: {}` 表示无参；有参用 `tool.schema.string()` 等。
- `execute` 返回 `JSON.stringify(...)` 字符串（见 2.4 的坑）。
- `context.directory` = session 工作目录。
- 想彻底不让 LLM 调用：opencode.json 加 `"permission": { "example": "deny" }`。

### 4.2 实际工具：dev_log

`tools/dev_log.ts` —— 首个实际在用的工具，读当前 workspace 的 vite 开发日志末尾 N 行（默认 100）。日志文件 `/tmp/vite-<appId>.log` 由 `preview.ts:93`（vite 启动重定向 stdout/stderr）写入，本工具只读。

- 传 `lines` 指定返回末尾多少行，默认 100。
- 从 `context.directory`（`/workspace/app-<appId>`）推 appId，agent 无需传参。
- 仅 vite 终端日志（编译错误/HMR）；浏览器运行时日志见 [browser-console-logs.md](./browser-console-logs.md)（未实现）。
- `build.txt` 调试节已引用：tsc 通过但预览异常、或改了 CSS/资源时调它排查。

---

## 5. 调试与常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| 调工具报 `undefined is not an object (evaluating 'u.split')` | `execute` 返回了对象/数组 | 改为 `return JSON.stringify(...)` |
| 工具没出现在 `/experimental/tool/ids` | 文件没进镜像 / 导出方式不对 | 确认 Dockerfile `COPY tools/`；确认 `export` 了 |
| agent 不主动调工具 | prompt 没告知 | 在 agent prompt 里写明何时用 |
| 自定义工具写了文件但 `edit` 权限没拦 | 自定义工具不走 `edit` 权限 | 用 `AgentConfig.tools` 禁用 |
| 工具要读项目外文件被拦 | `external_directory: deny` | opencode.json 放行特定路径，或工具内读（工具不受该权限限） |

验证工具注册：

```bash
# 工具 id 列表（最直接）
curl -s http://127.0.0.1:55001/experimental/tool/ids
# 期望含 example（及其它内置工具）

# 完整定义（需带 provider + model 参数）
curl -s "http://127.0.0.1:55001/experimental/tool?provider=deepseek&model=deepseek-v4-pro"

# agent 配置（确认 tools 开关）
curl -s http://127.0.0.1:55001/config | python3 -c "import sys,json;print(json.load(sys.stdin)['agent'])"
```

---

## 6. 附录

### A. `tool()` 与 Zod 速查

```ts
import { tool } from "@opencode-ai/plugin";

export const myTool = tool({
  description: "…",                       // LLM 看到的说明
  args: {
    str: tool.schema.string().describe("…"),
    num: tool.schema.number().optional(),
    arr: tool.schema.array(tool.schema.string()),
  },
  async execute(args, context) {
    const { directory, worktree, agent, sessionID, messageID } = context;
    return JSON.stringify({ ok: true });   // 必须返回字符串
  },
});
```

### B. opencode 内置工具清单

`bash` · `read` · `write` · `edit` · `grep` · `glob` · `apply_patch` · `webfetch` · `websearch` · `task` · `todowrite` · `skill` · `question` · `lsp`（实验） · `invalid`

（`write`/`apply_patch` 归 `edit` 权限管；`websearch` 需 OpenCode provider 或 `OPENCODE_ENABLE_EXA=1`。）

### C. AgentConfig.tools 字段

```ts
tools?: { [toolName: string]: boolean }
```
`true` 启用、`false` 禁用、未列 = 默认（启用）。按 agent 精细控制可用工具。

### D. 关键路径

| 路径 | 作用 |
|---|---|
| `apps/opencode-sandbox/tools/` | 工具源码（本项目） |
| `apps/opencode-sandbox/tools/example.ts` | 示例工具（仅供参考，未接入） |
| `apps/opencode-sandbox/tools/dev_log.ts` | dev_log：读 vite 开发日志（增量） |
| `apps/opencode-sandbox/opencode.json` | 权限 + agent tools 开关 |
| `apps/opencode-sandbox/Dockerfile` | `COPY tools/` 进镜像 |
| 容器内 `/root/.config/opencode/tools/` | 工具运行位置（全局） |
| 容器内 `/root/.config/opencode/node_modules/@opencode-ai/plugin` | tool helper 依赖 |
| `GET /experimental/tool/ids` | 验证工具注册（opencode serve :4096） |
