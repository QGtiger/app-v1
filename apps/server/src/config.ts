import Docker from "dockerode";

// 通过宿主机 docker.sock 控制 sandbox 容器（exec 进去跑 lightfish create / vite 等）。
// compose 里把 /var/run/docker.sock 挂进 server 容器，所以这里能直连。
export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// sandbox 容器名，必须与 docker-compose.yml 里 opencode-sandbox 的 container_name 一致。
export const CONTAINER_NAME = process.env.CONTAINER_NAME ?? "sandbox-host";

// 常驻 sandbox 容器引用，docker.getContainer 每次返回同一对象的句柄，可全局共享。
export const sandboxContainer = docker.getContainer(CONTAINER_NAME);

export const PORT = Number(process.env.PORT ?? 3060);

// opencode serve 的内部地址（compose 服务名），server 用它调 SDK 建 session。
// 注意：这是容器间内网地址，不是给浏览器用的；浏览器侧的 opencode 地址由前端自维护。
export const OPENCODE_HOST = process.env.OPENCODE_HOST ?? "opencode-sandbox";
export const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);

// 每个 workspace 的 vite 预览端口池（compose 里把该范围发布到宿主机）。
// 分配的端口记进 store（sessions.json），递增不复用，用完整个池子报错。
export const VITE_PORT_START = Number(process.env.VITE_PORT_START ?? 5174);
export const VITE_PORT_END = Number(process.env.VITE_PORT_END ?? 5199);

// 预览地址的宿主机名，返回给浏览器拼 previewUrl。
export const PREVIEW_HOST = process.env.PREVIEW_HOST ?? "localhost";

// 生产环境泛域名（如 "lightfish.top"）。为空时走本地 dev 模式。
// 设定后：serveUrl=https://oc.${PUBLIC_DOMAIN}，previewUrl=https://preview-${port}.${PUBLIC_DOMAIN}
export const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN ?? "";


// 浏览器直连 opencode serve 的对外地址。
// prod: https://oc.${PUBLIC_DOMAIN}；dev: SERVE_URL env（默认 http://localhost:55001）
export const serveUrl = PUBLIC_DOMAIN
  ? `https://oc.${PUBLIC_DOMAIN}`
  : process.env.SERVE_URL ?? "http://localhost:55001";
