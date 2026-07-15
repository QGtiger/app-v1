/**
 * store.ts — sessionId → {appId, port} 映射的持久化
 *
 * 交换键是 opencode 的 sessionId，但 workspace 目录 / 端口是 server 内部按 appId
 * 管理的，所以需要这层映射。落盘到 data/sessions.json（compose 挂载 ./data），
 * server 重启后 load 回内存。原子写（tmp + rename）防写坏。
 */
import fs from "node:fs";
import path from "node:path";

const STORE_FILE = path.join(process.cwd(), "data", "sessions.json");

export interface SessionEntry {
  appId: string;
  port: number;
}

const sessions = new Map<string, SessionEntry>();

export function loadStore(): void {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, SessionEntry>;
    for (const [k, v] of Object.entries(obj)) sessions.set(k, v);
    console.log(`[store] loaded ${sessions.size} sessions`);
  } catch {
    console.log("[store] no sessions.json, starting empty");
  }
}

function persist(): void {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const obj: Record<string, SessionEntry> = Object.fromEntries(sessions);
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

export function getSession(sessionId: string): SessionEntry | undefined {
  return sessions.get(sessionId);
}

export function setSession(sessionId: string, entry: SessionEntry): void {
  sessions.set(sessionId, entry);
  persist();
}

/** 当前已分配的所有端口（供端口分配取 max+1） */
export function allPorts(): number[] {
  return [...sessions.values()].map((v) => v.port);
}
