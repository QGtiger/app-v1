import Docker from "dockerode";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export const CONTAINER_NAME = process.env.CONTAINER_NAME ?? "sandbox-host";

export const sandboxContainer = docker.getContainer(CONTAINER_NAME);

export const PORT = Number(process.env.PORT ?? 3060);

export const SERVE_URL = process.env.SERVE_URL ?? "http://localhost:55001";
