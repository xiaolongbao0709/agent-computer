# AI Phone 角色电脑（agent-computer-template）

给小手机的角色和小坊（工坊）各配一台**云端小电脑**：持久硬盘 + shell 命令，
部署在**你自己的 Cloudflare 账号**里，数据只属于你。

基于 [`@cloudflare/computer`](https://github.com/cloudflare/computer)：

- **硬盘**：Durable Object 里的 SQLite 虚拟文件系统——持久、重启不丢、**免费计划可用**；
- **shell**：开箱即用，支持 ls/cat/grep/sed/管道 等常用命令（just-bash 内核，与
  Cloudflare 官方 shell 同款）。默认在 Worker 进程内执行（内嵌模式，免费计划可用）；
  账号具备 `worker_loaders`（beta）时可切换为动态 Worker 隔离执行（见下）；
- **隔离**：每个角色一台独立电脑（一个 workspace 一个 DO），互相看不见。

## 部署（一次，约 5 分钟）

1. 点小手机 设置 → 角色电脑 里的「一键部署」（或用下方按钮），登录你的 Cloudflare 账号；

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaolongbao0709/agent-computer)

2. 部署时会要求填 `AGENT_TOKEN`：自己编一段长随机字符串（这就是连接密钥，别泄露）；
3. 部署完成后复制 Worker 地址（形如 `https://ai-phone-agent-computer.你的子域.workers.dev`）；
4. 回小手机：设置 → 角色电脑 → 填入地址和密钥 → 连接测试。

## 常见问题

**shell 是怎么跑的？要额外配置吗？**
不用配置，默认就有：命令由内嵌的 just-bash 在 Worker 进程内执行（连接测试显示
"完整模式"）。它不是真 Linux——装不了 npm 包、跑不了任意二进制，但文件/文本处理的常用命令都齐，
`curl` 可用（只读联网：仅 GET/HEAD、禁内网地址、20s 超时、响应 ≤5MB）。若你的账号有 `worker_loaders`（beta）能力，可编辑
`wrangler.jsonc`：`compatibility_flags` 加 `"experimental"`、取消 `"worker_loaders"` 行注释，
重新部署后命令改在独立的动态 Worker 里执行（隔离性更强，能力相同）。部署报错则说明账号没有该能力，改回即可。

**费用？**
文件系统跑在 Workers 免费计划的额度内，日常使用一般不花钱。
本模板不使用容器，无需付费计划。

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
