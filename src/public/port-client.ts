// PUBLIC: minimal client for the game port (HTTP over a unix socket). Optional for MCP authors.
import { request } from "node:http";
import type { TimedPoint } from "./executor.js";

export interface PortReply {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}
export class GamePortClient {
  constructor(
    readonly socketPath = process.env.FN_GAME_PORT ?? "/run/fn/port.sock",
  ) {}
  call(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ): Promise<PortReply> {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }
  info() {
    return this.call("GET", "/v1/info");
  }
  status() {
    return this.call("GET", "/v1/status");
  }
  adapter(fn: string, args?: unknown) {
    return this.call("POST", "/v1/adapter", { fn, args });
  }
  path(points: TimedPoint[], options: { wait?: boolean } = {}) {
    return this.call("POST", "/v1/input/path", {
      points,
      wait: options.wait ?? true,
    });
  }
  click(x: number, y: number) {
    return this.call("POST", "/v1/input/click", { x, y });
  }
}
