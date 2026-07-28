import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";

/**
 * example — 自定义工具的【示例】，演示基本写法。
 *
 * 未被任何 agent prompt 引用，仅供参考；opencode 会自动注册为 `example` 工具。
 * 想彻底不让 LLM 调用，可在 opencode.json 加 `"permission": { "example": "deny" }`。
 *
 * 要点：
 * - description：LLM 据此判断何时调用，写清楚。
 * - args：用 tool.schema（即 Zod）定义参数；无参传 {}。
 * - execute：必须返回【字符串】；对象/数组用 JSON.stringify，否则会崩
 *   `undefined is not an object (evaluating 'u.split')`。
 * - context.directory：当前 session 的工作目录（/workspace/app-xxx）。
 */
export default tool({
  description: "示例工具：返回当前项目工作目录的基本信息（路径、是否 git 仓库）。",
  args: {},
  async execute(_args, context) {
    const dir = context.directory;
    const isGit = fs.existsSync(path.join(dir, ".git"));
    return JSON.stringify({ directory: dir, git: isGit });
  },
});
