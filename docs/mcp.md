# MCP Servers：外部工具集成

> 本文只讲 **MCP**（Model Context Protocol，独立进程、外部服务）。
> 进程内、操本地文件的轻量自定义工具见 **[custom-tools.md](./custom-tools.md)**。
> 关联：`docs/agent-architecture.md`、`apps/opencode-sandbox/opencode.json`

---

## 1. 是什么

MCP（Model Context Protocol）是一套标准协议，让 opencode 接入**独立进程**暴露的工具。MCP server 可以是本地 stdio 进程，也可以是远程 HTTP/SSE 服务。opencode 通过 `opencode.json` 的 `mcp` 配置连上它，其工具就以 `<server>_<tool>` 的名字暴露给 LLM。

与 [Custom Tools](./custom-tools.md) 的区别：Custom Tools 是 opencode 进程内的 TS 文件；MCP 是独立进程，适合连外部服务、复用生态里现成的 server。

---

## 2. 何时用 MCP

- 连**外部服务**：数据库、第三方 API、SaaS（GitHub / Slack / Postgres 等）
- 需要**进程隔离**：server 崩了不影响 opencode 主进程
- **复用现成 MCP server**：生态里有大量官方/社区 server，直接配即可用
- 需要**远程**能力：server 部署在别处，opencode 通过 URL 连

> 进程内、操本地文件、轻量能力（如 example 示例工具）用 [Custom Tools](./custom-tools.md) 更简单，不必上 MCP。

---

## 3. 配置

在 `opencode.json` 顶层加 `mcp` 段，每个 key 是 server 名（用于工具命名前缀），值是 local 或 remote 配置：

```jsonc
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "enabled": true,
      "timeout": 30000
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ghp_xxx" },
      "enabled": true
    }
  }
}
```

改完 `docker compose up -d --build opencode-sandbox` 重建生效。

---

## 4. 配置字段

### 4.1 本地 server（`type: "local"`，stdio）

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `"local"` | 固定 |
| `command` | `string[]` | 启动命令 + 参数（数组，如 `["npx","-y","pkg","arg"]`） |
| `cwd` | `string?` | 工作目录 |
| `environment` | `Record<string,string>?` | 注入子进程的环境变量（放 API key 等） |
| `enabled` | `boolean?` | 是否启用 |
| `timeout` | `number?` | 超时（ms） |

opencode 用 `command` 拉起子进程，通过 stdio 跟它说 MCP 协议。

### 4.2 远程 server（`type: "remote"`，HTTP/SSE）

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `"remote"` | 固定 |
| `url` | `string` | server 的 HTTP/SSE 端点 |
| `headers` | `Record<string,string>?` | 请求头（鉴权等） |
| `oauth` | `McpOAuthConfig \| false?` | OAuth 配置；`false` 关闭自动探测 |
| `enabled` | `boolean?` | 是否启用 |
| `timeout` | `number?` | 超时（ms） |

---

## 5. 如何添加一个 MCP server

1. **选 server**：从 [MCP server 生态](https://github.com/modelcontextprotocol/servers) 或自建。
2. **写配置**：`opencode.json` 的 `mcp` 段加一条（local 给 `command`，remote 给 `url`）。密钥放 `environment` / `headers`，**不要硬编码**——用 `{env:VAR}` 引用 `.env`。
3. **权限**（可选）：`permission` 里按 `<server>_*` 通配控 `allow`/`deny`/`ask`。
4. **重建**：`docker compose up -d --build opencode-sandbox`。
5. **验证**：`curl http://127.0.0.1:55001/experimental/tool/ids`，看是否多出 `<server>_<tool>` 名。

### 5.1 本地示例：文件系统 server

```jsonc
"mcp": {
  "fs": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    "enabled": true
  }
}
```
→ 暴露 `fs_read_file` / `fs_list_directory` 等工具。

### 5.2 本地示例：带密钥的自建 server

```jsonc
"mcp": {
  "myapi": {
    "type": "local",
    "command": ["node", "/opt/mcp-servers/myapi/server.js"],
    "environment": { "API_KEY": "{env:MY_API_KEY}" },
    "timeout": 30000
  }
}
```

### 5.3 远程示例：远程 MCP 服务

```jsonc
"mcp": {
  "github": {
    "type": "remote",
    "url": "https://api.example.com/mcp/",
    "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
  }
}
```

---

## 6. 工具命名与权限

- **命名**：MCP 工具名 = `<server名>_<工具名>`，server 名即 `mcp` 段的 key。如 `fs` server 的 `read_file` → `fs_read_file`。
- **权限**：在 `permission` 里按工具名控；通配整组 server：`"fs_*": "ask"`。
- **按 agent 开关**：`AgentConfig.tools: { "fs_read_file": false }` 可在某 agent 禁用特定 MCP 工具。
- **全局开关**：server 配置里 `enabled: false` 直接停用整个 server。

---

## 7. MCP vs Custom Tools 选型

| 维度 | Custom Tools | MCP |
|---|---|---|
| 运行位置 | opencode 进程内 | 独立进程 / 远程 |
| 定义方式 | `tools/*.ts` 文件 | `opencode.json` `mcp` 配置 |
| 适合 | 操本地文件、轻量、项目内逻辑 | 外部服务、DB、第三方 API、复用生态 |
| 隔离性 | 无（崩了影响 opencode） | 有（独立进程） |
| 依赖 | `@opencode-ai/plugin`（已装） | server 自带运行时（node/python…） |
| 本项目现状 | ✅ 已用（example 示例） | 暂未用 |

**一句话**：进程内、操文件 → Custom Tools；连外部、要隔离、复用现成 → MCP。

---

## 8. 附录

### A. 配置字段速查

```ts
// 本地
{ type: "local", command: string[], cwd?, environment?, enabled?, timeout? }
// 远程
{ type: "remote", url: string, headers?, oauth?, enabled?, timeout? }
```

### B. 注意事项

- **密钥**：放 `environment` / `headers`，用 `{env:VAR}` 引用 `.env`，勿硬编码进镜像。
- **超时**：网络/慢 server 设 `timeout`，避免拖住 agent。
- **工具数**：MCP server 可能暴露很多工具，会占 LLM 上下文；用 `permission`/`tools` 开关只留需要的。
- **沙箱安全**：本项目 sandbox 容器内 MCP server 能访问 `/workspace` 与环境变量；远程 server 仅按你给的凭证访问外部。评估每个 server 的权限范围。

### C. 验证命令

```bash
# 重建
docker compose up -d --build opencode-sandbox

# 看 MCP 工具是否注册（工具名 <server>_<tool>）
curl -s http://127.0.0.1:55001/experimental/tool/ids

# 看 server 连接状态（若 opencode 暴露 mcp status 端点）
curl -s http://127.0.0.1:55001/mcp 2>/dev/null | head -c 500
```
