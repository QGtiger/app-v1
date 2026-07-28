import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

const VITE_LOG_DIR = "/tmp";
const DEFAULT_LINES = 100;

function appIdFromDirectory(directory: string): string | null {
  const m = path.basename(directory).match(/^app-(.+)$/);
  return m ? m[1] : null;
}

/**
 * dev_log — 读取当前 workspace 的 vite 开发日志末尾 N 行。
 *
 * 日志文件 /tmp/vite-<appId>.log 由 preview.ts:93（vite 启动重定向 stdout/stderr）写入，
 * 含编译错误 / HMR 报错。本工具只读不写。
 *
 * 仅 vite 终端日志，不含浏览器运行时日志（那需第二层桥接，见 docs/browser-console-logs.md）。
 */
export default tool({
  description:
    "读取当前 workspace 的 vite 开发日志末尾 N 行（编译错误/HMR 报错）。改完代码后调它排查编译问题。默认 100 行。",
  args: {
    lines: tool.schema
      .number()
      .optional()
      .describe("返回末尾多少行，默认 100"),
  },
  async execute(args, context) {
    const appId = appIdFromDirectory(context.directory);
    if (!appId) return JSON.stringify({ error: `无法识别 appId: ${context.directory}` });
    const file = path.join(VITE_LOG_DIR, `vite-${appId}.log`);
    if (!fs.existsSync(file)) {
      return JSON.stringify({ error: `日志不存在: ${file}（vite 可能未启动）` });
    }
    const n = args.lines ?? DEFAULT_LINES;
    const tail = fs.readFileSync(file, "utf-8").split("\n").slice(-n).join("\n");
    return tail || "(日志为空)";
  },
});
