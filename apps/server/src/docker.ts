import { Writable } from "node:stream";
import type Docker from "dockerode";
import { docker } from "./config";

/**
 * 在指定容器内执行 shell 命令，等命令结束后返回 stdout+stderr 合并的文本。
 *
 * 注意：docker exec 的输出流是多路复用的——每个数据帧前 8 字节是帧头
 * （1 字节流类型 + 3 字节 padding + 4 字节 payload 长度）。
 * 这里简单跳过前 8 字节只取 payload，足以处理我们这种短命令的输出；
 * 若将来要跑长输出或需严格区分 stdout/stderr，应换成 execInContainerStream。
 */
export function execInContainer(
  container: Docker.Container,
  cmd: string,
  timeoutMs = 30000,
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    // 超时兜底：命令 hang 住（如曾经 curl 对 vite keep-alive 不退出）时强制 reject，
    // 避免单个 exec 永久卡死整个 SSE 流。
    const timer = setTimeout(
      () =>
        reject(
          new Error(`exec timed out (${timeoutMs}ms): ${cmd.slice(0, 80)}`),
        ),
      timeoutMs,
    );
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    try {
      const dockerExec = await container.exec({
        Cmd: ["sh", "-c", cmd],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await dockerExec.start({});
      let output = "";
      stream.on("data", (chunk: Buffer) => {
        const offset = chunk.length > 8 ? 8 : 0;
        output += chunk.subarray(offset).toString("utf-8");
      });
      stream.on("end", () => done(() => resolve(output)));
      stream.on("error", (e) => done(() => reject(e)));
    } catch (e) {
      done(() => reject(e));
    }
  });
}

/**
 * 流式 exec：命令运行期间通过 onChunk 实时回传输出，结束后 resolve 退出码。
 * 用 dockerode 的 demuxStream 把多路复用流正确拆成 stdout / stderr，
 * 避免 execInContainer 的 8 字节跳过 hack 在长输出/分包时丢数据。
 * 用于 SSE 推送 pnpm install 的实时日志。
 */
export function execInContainerStream(
  container: Docker.Container,
  cmd: string,
  onChunk: (text: string, stream: "stdout" | "stderr") => void,
): Promise<number> {
  return new Promise(async (resolve, reject) => {
    try {
      const dockerExec = await container.exec({
        Cmd: ["sh", "-c", cmd],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await dockerExec.start({});

      const stdout = new Writable({
        write(chunk, _enc, cb) {
          onChunk(chunk.toString("utf-8"), "stdout");
          cb();
        },
      });
      const stderr = new Writable({
        write(chunk, _enc, cb) {
          onChunk(chunk.toString("utf-8"), "stderr");
          cb();
        },
      });
      // dockerode modem 提供 demuxStream，按帧头拆分多路复用流
      (docker.modem as unknown as {
        demuxStream: (s: unknown, a: Writable, b: Writable) => void;
      }).demuxStream(stream, stdout, stderr);

      stream.on("end", async () => {
        try {
          const info = await dockerExec.inspect();
          resolve(info.ExitCode ?? 0);
        } catch {
          resolve(0);
        }
      });
      stream.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}
