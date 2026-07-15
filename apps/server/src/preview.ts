/**
 * preview.ts — 预览端口分配 + vite 生命周期
 *
 * 每个 workspace（按 appId）分配一个 vite 端口（5174-5199 池），端口记进 store
 * （sessions.json）。init 时在该端口启动 vite，/api/* 由模板的 apiServerPlugin
 * 作同端口中间件处理，无需额外后端端口。
 *
 * vite 以 nohup + & 脱离 exec 后台运行，日志写到 /tmp/vite-{appId}.log；
 * init SSE 轮询 cat 日志推 serve.log、lsof 探端口直到 ready。
 */
import {
  sandboxContainer,
  VITE_PORT_START,
  VITE_PORT_END,
  PREVIEW_HOST,
  PUBLIC_DOMAIN,
} from "./config";
import { execInContainer, execInContainerStream } from "./docker";
import { allPorts } from "./store";

export const previewUrl = (port: number) =>
  PUBLIC_DOMAIN
    ? `https://preview-${port}.${PUBLIC_DOMAIN}`
    : `http://${PREVIEW_HOST}:${port}`;

const dirOf = (appId: string) => `/workspace/app-${appId}`;
const logFile = (appId: string) => `/tmp/vite-${appId}.log`;

/** 扫描容器内当前正在监听的预览端口 */
async function listeningPorts(): Promise<Set<number>> {
  const out = await execInContainer(
    sandboxContainer,
    `lsof -i :${VITE_PORT_START}-${VITE_PORT_END} -sTCP:LISTEN -nP 2>/dev/null | grep -oE ':[0-9]+' | tr -d ':' || true`,
  );
  const set = new Set<number>();
  for (const line of out.split(/\s+/)) {
    const n = Number(line);
    if (n >= VITE_PORT_START && n <= VITE_PORT_END) set.add(n);
  }
  return set;
}

/**
 * 分配端口：从 START 往上扫，取第一个既未在 store 声明（claimed）、也未在容器内
 * 监听（occupied）的端口。复用 delete 释放的端口，无碎片化。整个池子用完才报错。
 */
export async function assignPreviewPort(): Promise<number> {
  const occupied = await listeningPorts();
  const claimed = new Set(allPorts());
  for (let p = VITE_PORT_START; p <= VITE_PORT_END; p++) {
    if (!occupied.has(p) && !claimed.has(p)) return p;
  }
  throw new Error(
    `no free preview port in [${VITE_PORT_START}, ${VITE_PORT_END}]`,
  );
}

export async function hasNodeModules(appId: string): Promise<boolean> {
  const out = await execInContainer(
    sandboxContainer,
    `test -d ${dirOf(appId)}/node_modules && echo y || echo n`,
  );
  return out.includes("y");
}

/** 端口是否在监听（lsof，不碰 HTTP，避免 curl 对 vite keep-alive 卡住不退出） */
export async function isPortListening(port: number): Promise<boolean> {
  const out = await execInContainer(
    sandboxContainer,
    `lsof -i :${port} -sTCP:LISTEN -nP 2>/dev/null | grep LISTEN || true`,
  );
  return out.includes("LISTEN");
}

/** pnpm install，实时回传日志，返回退出码 */
export async function runInstall(
  appId: string,
  onChunk: (text: string, stream: "stdout" | "stderr") => void,
): Promise<number> {
  return execInContainerStream(
    sandboxContainer,
    `cd ${dirOf(appId)} && pnpm install`,
    onChunk,
  );
}

/** 后台启动 vite（nohup 脱离 exec，进程在容器内常驻）。
 *  用 pnpm exec vite 而非 pnpm dev -- --port：后者会把 `--` 当字面量传给 vite，
 *  导致 --port 被忽略而落到默认 5173。pnpm exec 直接把参数透传给 vite。 */
export async function startVite(appId: string, port: number): Promise<void> {
  await execInContainer(
    sandboxContainer,
    `cd ${dirOf(appId)} && nohup pnpm exec vite --port ${port} --host 0.0.0.0 --strictPort > ${logFile(appId)} 2>&1 &`,
  );
}

/**
 * 轮询 vite 日志增量推给 onLog，同时 lsof 探端口是否在监听，直到 ready 或超时。
 * 返回 true 表示已就绪，false 表示超时。
 */
export async function waitForViteReady(
  appId: string,
  port: number,
  onLog: (text: string) => void,
  timeout = 60000,
): Promise<boolean> {
  const start = Date.now();
  let emitted = "";
  while (Date.now() - start < timeout) {
    const log = await execInContainer(
      sandboxContainer,
      `cat ${logFile(appId)} 2>/dev/null || true`,
    );
    if (log.length > emitted.length) {
      onLog(log.slice(emitted.length));
      emitted = log;
    }
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export { dirOf };
