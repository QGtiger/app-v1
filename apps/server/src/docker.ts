import type Docker from "dockerode";

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
