/**
 * publish.ts — 发布到 OSS + 通知部署 API
 *
 * 调用 sandbox 容器内的 `lightfish publish`：内部 build(vite build [+ server build/db push])
 * → 上传 OSS → POST 通知 DEPLOY_API_URL。发布凭证靠 sandbox 容器 env_file(.env) 注入的
 * process.env 提供（CLI loadDotenv 优先 process.env > .env），无需 server 额外传 env。
 *
 * 按 sessionId 互斥：同一 workspace 的 publish 串行（build 写 dist，并发会互相覆盖）；
 * 不同 workspace 可并行。锁独立于 routes 的 withLock，不阻塞 create/init/delete。
 *
 * 总超时 PUBLISH_TIMEOUT_MS 兜底：超时后按 cwd 精确 kill 该 workspace 的残留进程，
 * 避免 hang 的 build 继续吃内存加剧 OOM。
 */
import { sandboxContainer, PUBLISH_TIMEOUT_MS, OSS_BASE_ROOT } from "./config";
import { execInContainer, execInContainerStream } from "./docker";
import { dirOf } from "./preview";

/** 生成 UTC 时间戳版本号 YYYYMMDDHHmmss（与 CLI generateVersion 同算法，纯数字兼容部署 API number 契约）。 */
export function generateVersion(date: Date = new Date()): string {
  return date.toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
}

/** 读取 workspace 的 package.json#name 作为 appName。
 *  CLI 与 server 共用同一来源，避免 toPackageName 的小写化导致 server 拼的 URL 与实际发布地址不一致。 */
async function readAppName(appId: string): Promise<string> {
  const dir = dirOf(appId);
  const out = await execInContainer(
    sandboxContainer,
    `node -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('${dir}/package.json','utf8')).name||'')"`,
  );
  const name = out.trim();
  if (!name) throw new Error(`无法读取 ${dir}/package.json 的 name 字段`);
  return name;
}

/** 按 cwd 精确 kill 指定 workspace 的残留进程（超时/失败兜底，避免误杀其他 workspace 的并行 build）。 */
async function killWorkspaceProcesses(appId: string): Promise<void> {
  const dir = dirOf(appId);
  await execInContainer(
    sandboxContainer,
    `for p in $(grep -l "${dir}" /proc/*/cwd 2>/dev/null | sed 's|.*/proc/||;s|/cwd.*||'); do kill $p 2>/dev/null; done || true`,
  );
}

/** 单引号 shell 转义，安全拼接用户输入的 note。 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface PublishResult {
  version: string;
  appName: string;
  ossIndexUrl: string;
  domain: string;
}

/** 执行发布：生成 version → 读 appName → 容器内跑 lightfish publish → 超时兜底 → 返回发布地址。 */
export async function publishWorkspace(
  appId: string,
  options: { note?: string } = {},
  onChunk: (text: string, stream: "stdout" | "stderr") => void,
): Promise<PublishResult> {
  const dir = dirOf(appId);
  const version = generateVersion();
  const appName = await readAppName(appId);

  const note = options.note?.trim();
  const noteArg = note ? ` --note ${shellQuote(note)}` : "";
  const cmd = `cd ${dir} && lightfish publish --version ${version}${noteArg}`;

  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(
      () => reject(new Error(`publish timed out (${PUBLISH_TIMEOUT_MS}ms)`)),
      PUBLISH_TIMEOUT_MS,
    );
  });

  try {
    const exitCode = await Promise.race([
      execInContainerStream(sandboxContainer, cmd, onChunk),
      timer,
    ]);
    if (exitCode !== 0) {
      throw new Error(`lightfish publish exited ${exitCode}`);
    }
  } catch (e) {
    // 超时或 exec 失败：清理该 workspace 残留进程，避免 hang 的 build 继续占资源
    await killWorkspaceProcesses(appId).catch(() => {});
    throw e;
  } finally {
    if (timerHandle) clearTimeout(timerHandle);
  }

  return {
    version,
    appName,
    ossIndexUrl: `${OSS_BASE_ROOT}/${appName}/${version}/index.html`,
    domain: `https://${appName}.lightfish.top`,
  };
}

// 按 sessionId 互斥的发布锁：同 workspace 串行，不同 workspace 并行。
// 完成后自动清理 Map 条目，避免随 session 累积无限增长。
const publishLocks = new Map<string, Promise<unknown>>();

export function withPublishLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = publishLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const gate = run.then(
    () => undefined,
    () => undefined,
  );
  publishLocks.set(sessionId, gate);
  gate.then(() => {
    if (publishLocks.get(sessionId) === gate) publishLocks.delete(sessionId);
  });
  return run;
}
