// PRIVATE: strict stdio transport for a sandboxed MCP process. stdout must carry only
// newline-delimited JSON-RPC 2.0; anything else is recorded and fails the connection.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class StrictStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  violations: string[] = [];
  private child?: ChildProcess;
  private log: WriteStream;
  private stderr: WriteStream;
  private readonly epoch = performance.now();
  exitCode: number | null = null;
  private closed = false;
  constructor(
    readonly command: string,
    readonly args: string[],
    logPath: string,
    stderrPath: string,
  ) {
    this.log = createWriteStream(logPath, { flags: "a" });
    this.stderr = createWriteStream(stderrPath, { flags: "a" });
  }
  private record(direction: "in" | "out", line: string) {
    this.log.write(
      JSON.stringify({
        t_ms: Math.round(performance.now() - this.epoch),
        direction,
        line: line.length > 65536 ? line.slice(0, 65536) + "…" : line,
      }) + "\n",
    );
  }
  async start(): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        ...(process.env.DOCKER_HOST
          ? { DOCKER_HOST: process.env.DOCKER_HOST }
          : {}),
        ...(process.env.DOCKER_API_VERSION
          ? { DOCKER_API_VERSION: process.env.DOCKER_API_VERSION }
          : {}),
      },
    });
    this.child = child;
    child.stderr!.pipe(this.stderr, { end: false });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      this.record("in", line);
      if (!line.trim()) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        message = null;
      }
      if (
        !message ||
        typeof message !== "object" ||
        message.jsonrpc !== "2.0"
      ) {
        const violation = `non-JSON-RPC stdout: ${line.slice(0, 200)}`;
        this.violations.push(violation);
        this.onerror?.(new Error(violation));
        void this.close();
        return;
      }
      this.onmessage?.(message as JSONRPCMessage);
    });
    child.once("exit", (code) => {
      this.exitCode = code;
      this.onclose?.();
    });
    await new Promise<void>((done, reject) => {
      child.once("spawn", () => done());
      child.once("error", reject);
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const line = JSON.stringify(message);
    this.record("out", line);
    if (!this.child?.stdin?.writable)
      throw new Error("MCP process is not running");
    this.child.stdin.write(line + "\n");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      const exited = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(timer);
    }
    await new Promise<void>((done) => this.log.end(() => done()));
    await new Promise<void>((done) => this.stderr.end(() => done()));
  }
}
