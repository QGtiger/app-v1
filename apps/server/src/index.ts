import { serve } from "@hono/node-server";
import { routes } from "./routes";
import { sandboxContainer, CONTAINER_NAME, PORT } from "./config";

async function waitForContainer(timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const info = await sandboxContainer.inspect();
      if (info.State.Running) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`container ${CONTAINER_NAME} not running within ${timeout}ms`);
}

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
