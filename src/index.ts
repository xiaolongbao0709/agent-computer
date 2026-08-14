// AI Phone「角色电脑」——基于 @cloudflare/computer 的自部署 Worker。
//
// 一台部署 = 一批相互隔离的"电脑"（Workspace）：每个角色一台、小坊（工坊）一台。
// 每台电脑是一个 Durable Object，硬盘是 DO 里的 SQLite 虚拟文件系统（持久、免费计划可用）。
// shell 命令按可用性逐级选择：
//   容器（真 Linux，付费计划可选开启）→ isolate（worker_loaders beta）→ 内嵌 just-bash（保底，免费可用）。
//
// 安全模型：
//  - 所有请求必须带 Authorization: Bearer <AGENT_TOKEN>，密钥只在部署者自己手里；
//  - workspace 名单字符集白名单，一个 workspace 一个 DO，天然互相隔离；
//  - 路径禁止 ".."；输出与文件读取均有体积上限。

import { DurableObject } from "cloudflare:workers";
import { withWorkspace, getWorkspace, type DurableObjectStorageLike, type WorkspaceHandle } from "@cloudflare/computer";
import { WorkerShellBackend, WorkspaceFsAdapter, type WorkerShellLoader } from "@cloudflare/computer/backends/worker-shell";
import { CloudflareContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { Bash, NetworkAccessDeniedError, defineCommand, type SecureFetch } from "just-bash";

// isolate shell 的动态 Worker 通过这个服务代理回连本 Worker 的 Workspace，必须从入口导出；
// WorkspaceProxy 则是容器出网的回环绑定（ctx.exports 按入口导出解析），容器模式必需
export { WorkspaceServiceProxy, WorkspaceProxy } from "@cloudflare/computer";

type Env = {
  Computer: DurableObjectNamespace;
  // worker_loaders 绑定；账号没有该能力时按 wrangler.jsonc 注释删除绑定即可（shell 降级）
  LOADER?: WorkerShellLoader;
  AGENT_TOKEN?: string;
};

// cloudflare:workers 的 DurableObject 里 ctx/env 是 protected，
// withWorkspace 的选项工厂在类外运行，需要一层公开访问器。
class ComputerBase extends DurableObject<Env> {
  get doCtx() { return this.ctx; }
  get doEnv() { return this.env; }
}

// 容器宿主层：wrangler.jsonc 里打开 containers 配置后，容器会挂在这个 DO 上
//（ctx.container 出现），此时构造容器后端——computerd 跑在容器里，文件系统
// 与 DO 硬盘经包内置的 capnweb 会话双向同步，命令看到的就是同一块盘。
// 没挂容器（免费部署）时这里什么都不做，零开销。
class ComputerContainerHost extends withWorkspaceContainer(ComputerBase) {
  readonly containerBackend = (this.doCtx as { container?: unknown }).container
    ? new CloudflareContainerBackend({
        container: () => this,
        workspace: { binding: "Computer", id: this.doCtx.id.toString() },
        // 容器内命令直连外网（真 Linux 模式的网络是全功能的，README 有说明）
        egress: { mode: "direct" },
      })
    : null;
}

export class Computer extends withWorkspace(
  ComputerContainerHost,
  (self) => ({
    // workers-types 与包内自带类型对 SQL Row 的泛型声明有出入，运行时同物
    storage: self.doCtx.storage as unknown as DurableObjectStorageLike,
    backends: self.containerBackend
      ? [self.containerBackend]
      : self.doEnv.LOADER
        ? [
            new WorkerShellBackend({
              loader: self.doEnv.LOADER,
              workspace: { binding: "Computer", id: self.doCtx.id.toString() },
              ctx: self.doCtx,
            }),
          ]
        : [],
  }),
) {
  // computerd 从容器内向 DO 发起 /ws 升级建 capnweb 会话，交给容器后端处理
  override async fetch(request: Request): Promise<Response> {
    if (this.containerBackend) return this.containerBackend.handleFetch(request);
    return new Response("container backend not configured", { status: 501 });
  }
}

// ── HTTP 层 ──

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

type ActionBody = {
  action?: string;
  /** 哪台电脑：char:<角色id> / workshop / 其他自定义。字符白名单，一名一机。 */
  workspace?: string;
  path?: string;
  content?: string;
  base64?: string;
  command?: string;
  maxChars?: number;
};

const MAX_READ_CHARS = 200_000;
const MAX_WRITE_CHARS = 2_000_000;      // 约 2MB 文本
const MAX_WRITE_B64 = 8_000_000;        // 二进制 base64 上限（约 6MB 原始）
const MAX_EXEC_OUTPUT = 60_000;

function cleanWorkspace(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9:_-]{1,120}$/.test(value) ? value : null;
}

/** 绝对路径化 + 禁越级。每台电脑有独立文件系统，无需再关目录笼子。 */
function cleanPath(raw: unknown, fallback = "/"): string {
  let value = typeof raw === "string" ? raw.trim() : "";
  if (!value) value = fallback;
  value = value.replace(/\u0000/g, "");
  if (!value.startsWith("/")) value = `/${value}`;
  const segments = value.split("/").filter(seg => seg && seg !== ".");
  if (segments.includes("..")) throw new Error("路径不能包含 ..");
  return `/${segments.join("/")}`;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── 内嵌 shell（保底）───────────────────────────
// 账号没有 worker_loaders（beta）时，isolate 后端不可用；此时直接在本进程里
// 跑 just-bash（Cloudflare shell worker 的同款内核），文件系统对接同一块硬盘。
// 隔离性弱于动态 Worker，但命令只作用于虚拟盘、无网络（未配 fetch），风险面很小。

const EMBEDDED_MAX_OUTPUT = 200_000;

// 只读联网（给 curl 用）：仅 GET/HEAD、仅 http(s)、拦内网/回环地址、20s 超时、响应 ≤5MB。
// Workers 环境本身触不到部署者内网，字面量拦截属于双保险。
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const PRIVATE_HOST_RE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i;

const readOnlyFetch: SecureFetch = async (url, options = {}) => {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new NetworkAccessDeniedError(url, "只允许 GET/HEAD");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new NetworkAccessDeniedError(url, "仅支持 http/https");
  if (PRIVATE_HOST_RE.test(parsed.hostname)) throw new NetworkAccessDeniedError(url, "禁止访问内网地址");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS));
  try {
    const res = await fetch(url, {
      method,
      headers: options.headers as HeadersInit | undefined,
      signal: options.signal ?? controller.signal,
      redirect: options.followRedirects === false ? "manual" : "follow",
    });
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > FETCH_MAX_BYTES) throw new Error("响应超过 5MB 上限");
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    return { status: res.status, statusText: res.statusText, headers, body: new Uint8Array(buffer), url: res.url };
  } finally {
    clearTimeout(timer);
  }
};

type ExecOutcome = { stdout: string; stderr: string; exitCode: number; engine: "isolate" | "embedded" };

// uname 壳：这里没有 Linux 内核，如实报告自己是台云端小电脑——
// 免得探测脚本拿到 127 误判 shell 坏了
const unameCommand = defineCommand("uname", async (args) => {
  const all = args.includes("-a");
  const stdout = all
    ? "FloatOS float-computer 1.0-embedded just-bash cloudflare-workers wasm32\n"
    : "FloatOS\n";
  return { stdout, stderr: "", exitCode: 0 };
});

async function runShell(ws: Awaited<ReturnType<typeof getWorkspace>>, command: string): Promise<ExecOutcome> {
  try {
    using run = await ws.runtime.exec(command, { encoding: "utf8" });
    const { stdout, stderr, exitCode } = await run.result();
    return {
      stdout: typeof stdout === "string" ? stdout : "",
      stderr: typeof stderr === "string" ? stderr : "",
      exitCode: exitCode ?? 0,
      engine: "isolate",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/execution backend/i.test(message)) throw err;
    const bash = new Bash({
      fs: new WorkspaceFsAdapter(ws.fs as never) as never,
      cwd: "/",
      // 只读联网：curl 仅 GET/HEAD（看网页、下载内容），不开写方法——
      // Worker 不会被当成对外发请求的跳板
      fetch: readOnlyFetch,
      defenseInDepth: { enabled: false },
      executionLimits: { maxOutputSize: EMBEDDED_MAX_OUTPUT },
      customCommands: [unameCommand],
    });
    const result = await bash.exec(command);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, engine: "embedded" };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return fail("只接受 POST", 405);

    const expected = env.AGENT_TOKEN?.trim();
    if (!expected) return fail("服务端未配置 AGENT_TOKEN", 503);
    if (request.headers.get("authorization") !== `Bearer ${expected}`) return fail("密钥不正确", 401);

    let body: ActionBody;
    try {
      body = await request.json() as ActionBody;
    } catch {
      return fail("请求体不是合法 JSON");
    }

    const workspace = cleanWorkspace(body.workspace);
    if (!workspace) return fail("workspace 不合法（字母/数字/冒号/横线/下划线，≤120 字符）");
    const stub = env.Computer.get(env.Computer.idFromName(`ws/${workspace}`));

    try {
      using ws = await getWorkspace(stub as unknown as WorkspaceHandle);
      switch (body.action) {
        case "status": {
          // 文件系统探活 + shell 探活（shell 不可用不算错，报告能力即可）。
          // 用 uname 分辨壳的成色：容器里的真 Linux 回 "Linux"，内嵌壳如实回 "FloatOS"。
          await ws.fs.mkdir("/", { recursive: true }).catch(() => {});
          let shell = false;
          let engine: string | undefined;
          let linux = false;
          try {
            const probe = await runShell(ws, "echo ok");
            shell = probe.exitCode === 0;
            engine = probe.engine;
            if (shell) {
              // uname 单独探（isolate 的 just-bash 没有 uname，会 127，不算 shell 坏）
              const u = await runShell(ws, "uname").catch(() => null);
              linux = u ? /\bLinux\b/.test(u.stdout) : false;
            }
          } catch { /* 无 shell */ }
          const mode = !shell ? "fs-only" : linux ? "container" : "shell";
          return json({ ok: true, fs: true, shell, mode, engine: linux ? "container" : engine });
        }

        case "list": {
          const path = cleanPath(body.path);
          const entries = await ws.fs.readdir(path);
          return json({
            ok: true,
            path,
            entries: entries.map(entry => ({ name: entry.name, dir: Boolean(entry.isDirectory) })),
          });
        }

        case "read": {
          const path = cleanPath(body.path);
          if (path === "/") return fail("请指定文件路径");
          const maxChars = Math.max(1, Math.min(MAX_READ_CHARS, Number(body.maxChars) || MAX_READ_CHARS));
          const text = await ws.fs.readFile(path, "utf8");
          const truncated = text.length > maxChars;
          return json({ ok: true, path, content: truncated ? text.slice(0, maxChars) : text, truncated });
        }

        case "read_base64": {
          const path = cleanPath(body.path);
          if (path === "/") return fail("请指定文件路径");
          const stream = await ws.fs.readFile(path);
          const buffer = await new Response(stream as ReadableStream).arrayBuffer();
          if (buffer.byteLength > MAX_WRITE_B64) return fail("文件太大，无法经此接口传输（≤6MB）");
          return json({ ok: true, path, base64: toBase64(new Uint8Array(buffer)) });
        }

        case "write": {
          const path = cleanPath(body.path);
          if (path === "/") return fail("请指定文件路径");
          await ws.fs.mkdir(parentDir(path), { recursive: true }).catch(() => {});
          if (typeof body.base64 === "string") {
            if (body.base64.length > MAX_WRITE_B64) return fail("内容超限（base64 ≤8MB）");
            await ws.fs.writeFile(path, fromBase64(body.base64));
          } else {
            const content = typeof body.content === "string" ? body.content : "";
            if (content.length > MAX_WRITE_CHARS) return fail("内容超限（文本 ≤2MB）");
            await ws.fs.writeFile(path, content);
          }
          return json({ ok: true, path });
        }

        case "mkdir": {
          const path = cleanPath(body.path);
          await ws.fs.mkdir(path, { recursive: true });
          return json({ ok: true, path });
        }

        case "delete": {
          const path = cleanPath(body.path);
          if (path === "/") return fail("不能删除根目录");
          await ws.fs.rm(path, { recursive: true });
          return json({ ok: true, path });
        }

        case "exec": {
          const command = typeof body.command === "string" ? body.command.trim() : "";
          if (!command) return fail("缺少 command");
          if (command.length > 4000) return fail("命令过长");
          try {
            const result = await runShell(ws, command);
            const clip = (value: string) =>
              value.length > MAX_EXEC_OUTPUT ? `${value.slice(0, MAX_EXEC_OUTPUT)}\n…（输出过长已截断）` : value;
            return json({ ok: true, exitCode: result.exitCode, stdout: clip(result.stdout), stderr: clip(result.stderr), engine: result.engine });
          } catch (err) {
            return fail(`shell 不可用或执行失败：${err instanceof Error ? err.message : String(err)}`, 501);
          }
        }

        default:
          return fail("未知 action（status/list/read/read_base64/write/mkdir/delete/exec）");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found|no such/i.test(message)) return fail(`文件或目录不存在（${message}）`, 404);
      return fail(`操作失败：${message}`, 502);
    }
  },
} satisfies ExportedHandler<Env>;
