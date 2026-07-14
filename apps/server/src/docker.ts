import type Docker from "dockerode";

/**
 * 在指定容器内执行 shell 命令，返回 stdout+stderr 合并的文本。
 *
 * 注意：docker exec 的输出流是多路复用的——每个数据帧前 8 字节是帧头
 * （1 字节流类型 + 3 字节 padding + 4 字节 payload 长度）。
 * 这里简单跳过前 8 字节只取 payload，足以处理我们这种短命令的输出；
 * 若将来要跑长输出或需严格区分 stdout/stderr，应换成 dockerode 的 demuxStream。
 */
export function execInContainer(
  container: Docker.Container,
  cmd: string,
): Promise<string> {
  return new Promise(async (resolve, reject) => {
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
      stream.on("end", () => resolve(output));
      stream.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}
