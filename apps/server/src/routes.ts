import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { sandboxContainer, SERVE_URL } from "./config";
import { execInContainer } from "./docker";

const dirOf = (id: string) => `/workspace/session-${id}`;

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const app = new Hono();
app.use(cors());

app.post("/api/workspaces", async (c) => {
  const id = nanoid(12);
  const dir = dirOf(id);
  await execInContainer(
    sandboxContainer,
    `cd /workspace && lightfish create session-${id} -y`,
  );
  return c.json({ id, directory: dir, serveUrl: SERVE_URL });
});

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

app.get("/api/health", async (c) => {
  try {
    await sandboxContainer.inspect();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 502);
  }
});

export { app as routes };
