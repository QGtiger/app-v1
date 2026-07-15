import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { sandboxContainer } from "./config";
import { execInContainer } from "./docker";
import * as preview from "./preview";
import { dirOf } from "./preview";
import * as opencode from "./opencode";
import { getSession, setSession, removeSession } from "./store";

// 交换键是 opencode 的 sessionId（形如 ses_xxx），用它做 URL/接口参数。
// appId（nanoid）是 workspace 目录名，纯内部，不暴露。
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 进程内互斥锁：assign→createSession→store.set 必须原子，否则并发 POST 会抢到同一端口。
let mutexChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutexChain.then(fn, fn);
  mutexChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const app = new Hono();
app.use(cors());

/**
 * 新建 workspace：lightfish create --skip-install（只脚手架，不装依赖，放锁外）
 * + 分配预览端口 + 调 opencode SDK 建 session 拿 sessionId + 存映射（锁内原子）。
 */
app.post("/api/workspaces", async (c) => {
  const appId = nanoid(12);
  const dir = dirOf(appId);
  try {
    await execInContainer(
      sandboxContainer,
      `cd /workspace && lightfish create app-${appId} -y --skip-install`,
    );
    const { sessionId, port } = await withLock(async () => {
      const port = await preview.assignPreviewPort();
      const sessionId = await opencode.createSession(dir);
      setSession(sessionId, { appId, port });
      return { sessionId, port };
    });
    return c.json({
      sessionId,
      directory: dir,
      previewPort: port,
      previewUrl: preview.previewUrl(port),
    });
  } catch (e) {
    // 建失败清掉残留目录，避免脏数据
    await execInContainer(sandboxContainer, `rm -rf ${dir}`).catch(() => {});
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

/**
 * 查询单个 workspace 信息：通过 sessionId 换取 directory / port / previewUrl。
 * 前端刷新聊天页时调此接口恢复 directory（location.state 不持久）。
 */
app.get("/api/workspaces/:sessionId", async (c) => {
  const { sessionId } = c.req.param();
  if (!ID_RE.test(sessionId)) {
    return c.json({ error: "invalid sessionId" }, 400);
  }
  const entry = getSession(sessionId);
  if (!entry) {
    return c.json({ error: "workspace not found" }, 404);
  }
  const { appId, port } = entry;
  return c.json({
    sessionId,
    directory: dirOf(appId),
    previewPort: port,
    previewUrl: preview.previewUrl(port),
  });
});

/**
 * 停止预览：kill 该端口的 vite。保留目录/opencode session/store 映射，
 * 再调 init 会自动重启 vite。用于手动释放内存。
 */
app.post("/api/workspaces/:sessionId/stop", async (c) => {
  const { sessionId } = c.req.param();
  if (!ID_RE.test(sessionId)) {
    return c.json({ error: "invalid sessionId" }, 400);
  }
  const entry = getSession(sessionId);
  if (!entry) {
    return c.json({ error: "workspace not found" }, 404);
  }
  const wasRunning = await preview.isPortListening(entry.port);
  if (wasRunning) {
    await execInContainer(
      sandboxContainer,
      `lsof -ti :${entry.port} -sTCP:LISTEN 2>/dev/null | while read pid; do kill $pid; done`,
    );
  }
  return c.json({ stopped: wasRunning });
});

/**
 * 彻底删除：停 vite → 删目录 → 删 opencode session → 删 store 映射。
 * 端口槽释放（扫最低空闲时会复用）。store 无此 sessionId → 404。
 */
app.delete("/api/workspaces/:sessionId", async (c) => {
  const { sessionId } = c.req.param();
  if (!ID_RE.test(sessionId)) {
    return c.json({ error: "invalid sessionId" }, 400);
  }
  const entry = getSession(sessionId);
  if (!entry) {
    return c.json({ error: "workspace not found" }, 404);
  }
  const { appId, port } = entry;
  const dir = dirOf(appId);
  // 停 vite（best-effort）
  await execInContainer(
    sandboxContainer,
    `lsof -ti :${port} -sTCP:LISTEN 2>/dev/null | while read pid; do kill $pid; done`,
  ).catch(() => {});
  // 删目录
  await execInContainer(sandboxContainer, `rm -rf ${dir}`).catch(() => {});
  // 删 opencode session（best-effort，失败只 log，不阻断清理）
  await opencode.deleteSession(sessionId, dir).catch((e) => {
    console.error(`[delete] opencode session delete failed for ${sessionId}:`, e);
  });
  // 删 store 映射
  removeSession(sessionId);
  return c.json({ ok: true });
});

/**
 * 初始化 workspace + 确保预览服务已启动（SSE 流式推送进度与日志）。
 *
 * 事件协议：
 *   init        {sessionId, directory, port, previewUrl}
 *   install.start / install.log{stream,text} / install.done{exitCode} / install.skip{reason}
 *   serve.start / serve.log{text} / serve.skip{reason}
 *   ready       {previewUrl, port}
 *   error       {phase:"install"|"serve"|"unknown", message}
 *
 * 幂等：node_modules 已存在则跳过安装；vite 已在端口监听则跳过启动。
 * store 无此 sessionId → 404（前端刷新/恢复时也走这里拿 directory+port）。
 */
app.get("/api/workspaces/:sessionId/init", async (c) => {
  const { sessionId } = c.req.param();
  if (!ID_RE.test(sessionId)) {
    return c.json({ error: "invalid sessionId" }, 400);
  }
  const entry = getSession(sessionId);
  if (!entry) {
    return c.json({ error: "workspace not found" }, 404);
  }
  const { appId, port } = entry;
  const dir = dirOf(appId);
  const exists = await execInContainer(
    sandboxContainer,
    `test -d ${dir} && echo exists || echo missing`,
  );
  if (!exists.includes("exists")) {
    return c.json({ error: "workspace not found" }, 404);
  }

  return streamSSE(c, async (sse) => {
    const aborted = { current: false };
    sse.onAbort(() => {
      aborted.current = true;
    });
    // writeSSE 是异步的（写 WritableStream），必须 await 才能保证事件在流关闭前刷出；
    // 否则函数 return 时未 flush 的 serve.skip/ready 会丢。
    const send = async (event: string, data: unknown) => {
      if (aborted.current) return;
      try {
        await sse.writeSSE({ event, data: JSON.stringify(data) });
      } catch {
        // 客户端已断开，忽略写入失败
      }
    };

    await send("init", {
      sessionId,
      directory: dir,
      port,
      previewUrl: preview.previewUrl(port),
    });

    try {
      // 1. 安装依赖
      if (!(await preview.hasNodeModules(appId))) {
        await send("install.start", {});
        const exitCode = await preview.runInstall(appId, (text, stream) =>
          send("install.log", { stream, text }),
        );
        await send("install.done", { exitCode });
        if (exitCode !== 0) {
          await send("error", { phase: "install", message: `pnpm install exited ${exitCode}` });
          return;
        }
      } else {
        await send("install.skip", { reason: "node_modules exists" });
      }
      if (aborted.current) return;

      // 2. 启动 vite 预览
      if (await preview.isPortListening(port)) {
        await send("serve.skip", { reason: "already running" });
      } else {
        await send("serve.start", {});
        await preview.startVite(appId, port);
        const ready = await preview.waitForViteReady(appId, port, (text) =>
          send("serve.log", { text }),
        );
        if (!ready) {
          await send("error", { phase: "serve", message: "vite did not become ready (timeout)" });
          return;
        }
      }
      if (aborted.current) return;

      // 3. 就绪
      await send("ready", { previewUrl: preview.previewUrl(port), port });
    } catch (e) {
      console.error("[init] error:", e);
      await send("error", { phase: "unknown", message: String(e) });
    }
  });
});

/** 健康检查：sandbox 容器在则 ok。 */
app.get("/api/health", async (c) => {
  try {
    await sandboxContainer.inspect();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 502);
  }
});

export { app as routes };
