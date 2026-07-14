import { serve } from "@hono/node-server";
import { routes } from "./routes";
import { sandboxContainer, CONTAINER_NAME, PORT } from "./config";

/**
 * 轮询等待 sandbox 容器进入 running 状态。
 * compose 的 depends_on 只保证容器被创建/启动，不保证进程就绪；
 * 而 server 的所有操作都靠 docker exec 进 sandbox，容器没起来 exec 必失败，
 * 所以启动前必须先确认它 running。配合 restart:always 实现启动顺序兜底。
 */
async function waitForContainer(timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const info = await sandboxContainer.inspect();
      if (info.State.Running) return;
    } catch {
      // 容器还没创建，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`container ${CONTAINER_NAME} not running within ${timeout}ms`);
}

// 顶层 await：package.json 的 "type":"module" + tsup esm 输出支持。
await waitForContainer();

const server = serve({
  fetch: routes.fetch,
  port: PORT,
  hostname: "0.0.0.0",
});

console.log(`[server] ready on http://0.0.0.0:${PORT}`);

const shutdown = async () => {
  console.log("[server] shutting down...");
  server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
