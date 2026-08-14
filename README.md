# AI Phone 角色电脑（agent-computer-template）

给小手机的角色和小坊（工坊）各配一台**云端小电脑**：持久硬盘 + shell 命令，
部署在**你自己的 Cloudflare 账号**里，数据只属于你。

基于 [`@cloudflare/computer`](https://github.com/cloudflare/computer)：

- **硬盘**：Durable Object 里的 SQLite 虚拟文件系统——持久、重启不丢、**免费计划可用**；
- **shell**：开箱即用，支持 ls/cat/grep/sed/管道 等常用命令（just-bash 内核，与
  Cloudflare 官方 shell 同款）。默认在 Worker 进程内执行（内嵌模式，免费计划可用）；
  账号具备 `worker_loaders`（beta）时可切换为动态 Worker 隔离执行（见下）；
- **容器模式（可选，付费计划）**：真 Linux——apt/npm/pip、全功能网络，见下方「升级容器模式」；
- **隔离**：每个角色一台独立电脑（一个 workspace 一个 DO），互相看不见。

## 部署（一次，约 5 分钟）

1. 点小手机 设置 → 角色电脑 里的「一键部署」（或用下方按钮），登录你的 Cloudflare 账号；

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaolongbao0709/agent-computer)

2. 部署时会要求填 `AGENT_TOKEN`：自己编一段长随机字符串（这就是连接密钥，别泄露）；
3. 部署完成后复制 Worker 地址（形如 `https://ai-phone-agent-computer.你的子域.workers.dev`）；
4. 回小手机：设置 → 角色电脑 → 填入地址和密钥 → 连接测试。

## 以后怎么更新？

部署向导会把模板复制成你自己的仓库，它不会自动跟随模板更新。更新有两种方式：

- **一键同步（推荐，需一次性启用）**：把模板里的 `extras/sync-template.yml` 复制到你仓库的
  `.github/workflows/` 目录（只需做这一次；部署向导没有写入 workflow 的权限，所以这步得手动）。
  之后更新就是：仓库页 → **Actions** → 「同步上游模板」→ **Run workflow**——它把模板最新文件
  搬进你的仓库并提交，Cloudflare 随即自动重新部署（每周一也会自动跑一次；不想要自动跑，
  删掉工作流里的 `schedule` 段即可）。你的 `wrangler.jsonc`（容器/isolate 开关）不会被覆盖。
  Worker 地址、密钥、硬盘数据在更新中全部保持不变。
- **手动**：把模板仓库里变化的文件复制进你的仓库提交即可，效果相同。

## 部署按钮失败 / 想删掉重新部署？

一键部署向导偶尔会抽风（比如对导入过的仓库报 "Failed to get repository contents"）。
**不用跟它耗**，走仪表盘的 Git 导入，效果一样：

1. 确保你的 GitHub 里有模板的副本仓库：之前部署过的话它还在，直接用；没有的话
   打开本模板仓库 → 右上角 **Fork**（或把文件下载后传到自己的新仓库，公开私有均可）；
2. Cloudflare 仪表盘 → **Compute (Workers)** → **Create** → **Import a repository** →
   授权 GitHub 后选中副本仓库 → **Deploy**（构建设置保持默认，会自动识别 wrangler.jsonc）；
3. 部署后进这个 Worker 的 **Settings → Variables and Secrets** → 添加变量
   `AGENT_TOKEN`（类型选 **Secret**，值自己编一段长随机字符串）→ 会自动重新部署一次；
4. 回小手机：设置 → 角色电脑 → 填 Worker 地址和这串密钥 → 连接测试。

这条路和一键部署的最终形态完全一样（仓库一提交就自动重建），且不挑"是否导入过"。

**提醒**：删除 Worker 会把所有电脑的硬盘数据（角色日记、文件）一并清空且无法找回；
只是更新的话永远不需要删 Worker——改副本仓库就行。

## 常见问题

**shell 是怎么跑的？要额外配置吗？**
不用配置，默认就有：命令由内嵌的 just-bash 在 Worker 进程内执行（连接测试显示
"完整模式"）。它不是真 Linux——装不了 npm 包、跑不了任意二进制，但文件/文本处理的常用命令都齐，
`curl` 可用（只读联网：仅 GET/HEAD、禁内网地址、20s 超时、响应 ≤5MB）。若你的账号有 `worker_loaders`（beta）能力，可编辑
`wrangler.jsonc`：`compatibility_flags` 加 `"experimental"`、取消 `"worker_loaders"` 行注释，
重新部署后命令改在独立的动态 Worker 里执行（隔离性更强，能力相同）。部署报错则说明账号没有该能力，改回即可。

**费用？**
文件系统跑在 Workers 免费计划的额度内，日常使用一般不花钱。
默认配置不使用容器，无需付费计划；容器模式（见下）才需要。

## 升级容器模式（真 Linux，可选）

想让电脑变成**真正的 Linux**（能 `apt` / `npm install` / `pip install`、跑任意程序、
全功能联网），可以开启容器模式。**前提**：Cloudflare 账号开通 Workers 付费计划
（$5/月起）。容器按实际运行秒数另计费，不用时自动休眠不花钱；付费计划自带每月
一定量的免费容器额度，聊天式的零星使用大概率不超。

**全新部署（推荐，零配置）**：直接用容器版部署链接——

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaolongbao0709/agent-computer/tree/container)

（小手机 设置 → 角色电脑 里也有「容器版部署」按钮。）容器版分支的配置已经开好，
流程和普通部署完全一样，不用改任何文件。

**已有部署原地升级（保留硬盘数据）**：

1. 打开你部署用的仓库，编辑 `wrangler.jsonc`：取消 `"containers"` 整段的注释；
2. 提交后 Cloudflare 自动重新构建（第一次要构建容器镜像，比平时慢几分钟）；
3. 回小手机做一次「连接测试」，显示 **容器模式（真 Linux）** 即成功。

容器模式下：每台电脑（每个角色 / 小坊）一个独立容器实例；硬盘仍在 DO 里持久保存，
容器经 FUSE 把这块硬盘挂载在 `/workspace`——命令读写的就是角色电脑的持久硬盘，
容器休眠/回收不丢数据。想预装更多软件（pandoc、ffmpeg 等），编辑 `Dockerfile` 追加即可。

注意：容器里的网络是**全功能**的（不再限于只读 GET），角色和小坊能对外发任意请求——
这是"以信任换自由度"的模式，介意的话保持默认配置即可。

**数据在哪里？**
全部在你自己 Cloudflare 账号的 Durable Object 存储里，删掉 Worker 即全部清除。

## 接口（供小手机调用）

所有请求：`POST /`，头 `Authorization: Bearer <AGENT_TOKEN>`，体为 JSON：

| action | 参数 | 说明 |
|---|---|---|
| `status` | `workspace` | 探活，返回 `mode: "shell" \| "fs-only"` |
| `list` | `workspace, path` | 列目录 |
| `read` | `workspace, path, maxChars?` | 读文本文件 |
| `read_base64` | `workspace, path` | 读二进制（≤6MB） |
| `write` | `workspace, path, content \| base64` | 写文件（自动建父目录） |
| `mkdir` | `workspace, path` | 建目录 |
| `delete` | `workspace, path` | 删除（递归） |
| `exec` | `workspace, command` | 执行 shell 命令（fs-only 模式返回 501） |

`workspace` 约定：角色用 `char:<角色id>`，工坊用 `workshop`。
