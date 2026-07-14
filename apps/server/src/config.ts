import Docker from "dockerode";

// 通过宿主机 docker.sock 控制 sandbox 容器（exec 进去跑 lightfish create 等）。
// compose 里把 /var/run/docker.sock 挂进 server 容器，所以这里能直连。
export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// sandbox 容器名，必须与 docker-compose.yml 里 opencode-sandbox 的 container_name 一致。
export const CONTAINER_NAME = process.env.CONTAINER_NAME ?? "sandbox-host";

// 常驻 sandbox 容器引用，docker.getContainer 每次返回同一对象的句柄，可全局共享。
export const sandboxContainer = docker.getContainer(CONTAINER_NAME);

export const PORT = Number(process.env.PORT ?? 3060);

// 返回给浏览器的 opencode serve 地址（宿主机端口）。
// 浏览器拿到后直连 opencode 跑 session.create / 聊天，不经本 server 代理。
export const SERVE_URL = process.env.SERVE_URL ?? "http://localhost:55001";
