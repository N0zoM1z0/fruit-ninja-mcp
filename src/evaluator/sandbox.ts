// PRIVATE: Docker sandboxes for the builder and for generated-MCP play. Every container is
// labelled with this project and run id; cleanup only ever targets those labels.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "../upstream.js";

export const project = "fruit-ninja-self-mcp";
export const imageTag = () => process.env.FNSM_IMAGE_TAG ?? "dev";
export const images = () => ({
  builder: `${project}/builder:${imageTag()}`,
  play: `${project}/play:${imageTag()}`,
});
export const sandboxUser = "10001:10001";
export const newRunId = (prefix = "r") =>
  `${prefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** Short, host-visible directory for one game-port socket (unix paths are limited to 108 bytes). */
export async function socketDir(runId: string): Promise<string> {
  const dir = resolve(root, ".local/sock", runId);
  if (Buffer.byteLength(resolve(dir, "port.sock")) > 100)
    throw new Error(`Socket path too long: ${dir}`);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}
export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}
export function run(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExecResult> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      truncated = false,
      timedOut = false;
    const take = (current: string, chunk: Buffer) => {
      if (current.length + chunk.length > maxBytes) {
        truncated = true;
        return (
          current +
          chunk.toString("utf8", 0, Math.max(0, maxBytes - current.length))
        );
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = take(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = take(stderr, chunk)));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        stdout,
        stderr,
        duration_ms: Math.round(performance.now() - started),
        timed_out: timedOut,
        truncated,
      });
    });
    child.stdin.end(options.input);
  });
}
export const docker = (args: string[], options?: Parameters<typeof run>[2]) =>
  run("docker", args, options);

export const labels = (runId: string, role: string) => [
  "--label",
  `fnsm.project=${project}`,
  "--label",
  `fnsm.run=${runId}`,
  "--label",
  `fnsm.role=${role}`,
];
/** Shared container hardening: no network, no capabilities, read-only root, unprivileged. */
export const hardening = [
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  sandboxUser,
  "--ipc",
  "private",
];

/** Long-lived builder sandbox: packaged game, Chromium and public tools only. */
export class BuilderSandbox {
  private constructor(
    readonly name: string,
    readonly runId: string,
  ) {}
  static async start(runId: string): Promise<BuilderSandbox> {
    const name = `fnsm-b-${runId}`;
    const result = await docker([
      "run",
      "-d",
      "--name",
      name,
      ...labels(runId, "builder"),
      ...hardening,
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--shm-size",
      "512m",
      "--tmpfs",
      "/tmp:rw,exec,size=512m,mode=1777",
      "--tmpfs",
      "/work:rw,exec,size=1g,uid=10001,gid=10001,mode=0755",
      "--tmpfs",
      "/output:rw,size=256m,uid=10001,gid=10001,mode=0755",
      "-e",
      "HOME=/work",
      images().builder,
    ]);
    if (result.exit_code !== 0)
      throw new Error(
        `Builder sandbox failed to start: ${result.stderr.trim()}`,
      );
    return new BuilderSandbox(name, runId);
  }
  exec(
    argv: string[],
    options: {
      timeoutMs?: number;
      cwd?: string;
      input?: string;
      maxBytes?: number;
    } = {},
  ): Promise<ExecResult> {
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      !argv.every((v) => typeof v === "string" && !v.includes("\0"))
    )
      throw new Error("exec requires a non-empty argv array of strings");
    const timeoutMs = Math.max(
      1000,
      Math.min(options.timeoutMs ?? 30_000, 600_000),
    );
    return docker(
      [
        "exec",
        "-i",
        "-u",
        sandboxUser,
        "-w",
        options.cwd ?? "/work",
        this.name,
        "timeout",
        "-k",
        "2",
        String(Math.ceil(timeoutMs / 1000)),
        ...argv,
      ],
      {
        input: options.input,
        timeoutMs: timeoutMs + 5000,
        maxBytes: options.maxBytes,
      },
    );
  }
  async stop(): Promise<void> {
    await docker(["rm", "-f", this.name]);
  }
}

/** docker argv for one generated-MCP process: frozen mcp/ read-only, game port socket only. */
export function playArgs(
  runId: string,
  frozenMcpDir: string,
  socketDir: string,
): string[] {
  return [
    "run",
    "-i",
    "--rm",
    "--init",
    "--name",
    `fnsm-p-${runId}`,
    ...labels(runId, "play"),
    ...hardening,
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/tmp:rw,size=64m,mode=1777",
    "-e",
    "FN_GAME_PORT=/run/fn/port.sock",
    "-e",
    "HOME=/tmp",
    "-v",
    `${frozenMcpDir}:/opt/mcp:ro`,
    "-v",
    `${socketDir}:/run/fn:ro`,
    images().play,
    "/opt/mcp/launch.sh",
  ];
}
export async function removeRunContainers(runId: string): Promise<void> {
  const list = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=fnsm.run=${runId}`,
  ]);
  const ids = list.stdout.split("\n").filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
}
export async function imageIds(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const [role, image] of Object.entries(images())) {
    const inspect = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]).catch(() => null);
    result[role] = inspect?.exit_code === 0 ? inspect.stdout.trim() : null;
  }
  return result;
}
