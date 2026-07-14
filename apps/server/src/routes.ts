import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { sandboxContainer, SERVE_URL } from "./config";
import { execInContainer } from "./docker";

// 单沙盒 + workspace 划分会话：每个会话独占 /workspace/session-{id} 子目录。
// server 只负责建目录（lightfish create 脚手架），不碰 opencode SDK / SSE；
// 浏览器拿到 directory 后直连 opencode serve 自己建 session、聊天。
const dirOf = (id: string) => `/workspace/session-${id}`;

// nanoid 默认字母表为 A-Za-z0-9_-，此正则同时校验生成的 id 与 URL 传入的 id，
// 拒绝 shell 元字符，避免 test -d 命令注入。
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const app = new Hono();
app.use(cors());

// 新建 workspace：生成 id → 在 sandbox 容器内 lightfish create 脚手架 → 返回目录与 opencode 地址。
// lightfish create 会顺带 pnpm install，首次约 10-20s。
app.post("/api/workspaces", async (c) => {
  const id = nanoid(12);
  const dir = dirOf(id);
  await execInContainer(
    sandboxContainer,
    `cd /workspace && lightfish create session-${id} -y`,
  );
  return c.json({ id, directory: dir, serveUrl: SERVE_URL });
});

// 查询 workspace 是否存在（浏览器刷新 / 恢复时用）。目录即真相，无额外存储。
app.get("/api/workspaces/:id", async (c) => {
  const { id } = c.req.param();
  if (!ID_RE.test(id)) {
    return c.json({ error: "invalid id" }, 400);
  }
  const dir = dirOf(id);
  const res = await execInContainer(
    sandboxContainer,
    `test -d ${dir} && echo exists || echo missing`,
  );
  if (!res.includes("exists")) {
    return c.json({ error: "workspace not found" }, 404);
  }
  return c.json({ id, directory: dir, serveUrl: SERVE_URL });
});

// 健康检查：sandbox 容器在则 ok。
app.get("/api/health", async (c) => {
  try {
    await sandboxContainer.inspect();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 502);
  }
});

export { app as routes };
