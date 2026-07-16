# 线上排查手册（sandbox 栈）

只讲「怎么查」，不讲「怎么修」。核心就几条命令，按症状对号入座。

## 架构速记

- `sandbox-host` 容器：PID 1 是 `tini`，托管 `opencode serve`（端口 4096）。**opencode 一死，整个容器就停**，`restart: always` 再拉起。
- `sandbox-server` 的所有操作（`lightfish create` / `pnpm install` / `vite`）都是 `docker exec` 进 sandbox-host 跑。**容器不是 running，exec 必 409。**

## 核心排查命令

### 1. 看容器状态 + 重启次数

```bash
docker ps -a --filter name=sandbox-host --format 'table {{.Names}}\t{{.Status}}'

docker inspect sandbox-host --format \
  'RestartCount={{.RestartCount}} Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}'
```

- `RestartCount` 涨了 = 重启过。记下当前值，触发操作再看，涨了就是重启。
- `OOMKilled=false` 别信——全局 OOM 不置这个标记，以 `dmesg` 为准。

### 2. 实时盯重启（最有用）

另开终端跑，再去触发操作：

```bash
docker events --filter container=sandbox-host --filter event=die --filter event=start
```

- `die exitCode=137` 紧跟 `start` = 被杀重启，**137 = SIGKILL（OOM）**。
- 只有 `exec_create`/`exec_start`、没有 `die` = 没重启，是命令卡住/超时。

看完整 exec 时间线（排查超时）：

```bash
docker events --filter container=sandbox-host
```

### 3. 看资源（内存 / swap）

```bash
free -h                          # 宿主机总内存 + swap，swap=0 是高危
docker stats --no-stream sandbox-host  # 容器实时占用
```

### 4. 查内核 OOM（实锤）

```bash
dmesg -T | grep -iE 'oom|killed process' | tail
```

`Out of memory: Killed process XXX (opencode)` = 内核杀了 opencode → PID 1 死 → 容器重启。

### 5. 看容器日志（崩溃原因）

```bash
docker logs sandbox-host --tail 80
```

找 `exec format error` / `not found` / `address already in use` / segfault。

### 6. 测二进制是否正常

```bash
docker run --rm app-v1-opencode-sandbox opencode --version
```

报 `exec format error` / segfault = 二进制变体/损坏（`node:24-slim` 只能用 `opencode-linux-x64.tar.gz`，不能是 musl/arm64/baseline）。

### 7. 给慢命令计时

```bash
docker exec -it sandbox-host sh -c 'time lightfish create test -y --skip-install'
```

## 症状 → 查哪条

| 症状 | 先查 | 判定 |
|------|------|------|
| init 报 `409 ... restarting` | 1 + 2 + 4 | RestartCount 涨 + `die 137` + dmesg 有 oom = OOM 重启 |
| 创建工作区慢 / 500 / 目录残留 | 2 + 7 | events 里 30s 整点触发 `rm`、且无 `exec_die` = 命令超时 + 孤儿 |
| opencode serve 起不来 | 5 + 6 | logs 报 exec 错 + `opencode --version` 失败 = 二进制问题 |
| 容器没重启但操作失败 | 2 | 只见 `exec_*`、无 `die` = 命令在跑，看 7 量耗时 |
