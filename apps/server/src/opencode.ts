/**
 * opencode.ts — server 侧调 opencode SDK 建 session
 *
 * POST 建工作区时，server 用内部地址（compose 服务名 opencode-sandbox:4096）调
 * opencode serve 的 session.create，拿到 sessionId 作为对外交换键。
 * 仅此一处碰 SDK（不代理 chat / SSE）。
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OPENCODE_HOST, OPENCODE_PORT } from "./config";

export async function createSession(directory: string): Promise<string> {
  const client = createOpencodeClient({
    baseUrl: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
    directory,
  });
  const result = (await client.session.create({ directory })) as {
    data?: { id?: string };
  };
  const sessionId = result.data?.id;
  if (!sessionId) {
    throw new Error("opencode session.create returned empty id");
  }
  return sessionId;
}

/** 删 opencode session（含消息/历史）。directory 可选，传入更稳（opencode 可能按目录定位 session）。 */
export async function deleteSession(
  sessionId: string,
  directory?: string,
): Promise<void> {
  const client = createOpencodeClient({
    baseUrl: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
    ...(directory ? { directory } : {}),
  });
  await client.session.delete({
    sessionID: sessionId,
    ...(directory ? { directory } : {}),
  });
}
