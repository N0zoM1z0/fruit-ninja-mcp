// PUBLIC: the game port is the ONLY channel from an agent-built MCP to the live game.
// It offers adapter calls (agent-authored, in-page, read-oriented) and the shared native
// input executor. It never returns referee state, screenshots or game events.
import { createServer, type IncomingMessage } from "node:http";
import { chmod, rm } from "node:fs/promises";
import type { TimedPoint } from "./executor.js";

export class PortError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(`${code}: ${message}`);
  }
}
export interface PortBackend {
  info(): Promise<Record<string, unknown>> | Record<string, unknown>;
  adapterCall(fn: string, args: unknown): Promise<unknown>;
  path(points: TimedPoint[], wait: boolean): Promise<Record<string, unknown>>;
  click(x: number, y: number): Promise<Record<string, unknown>>;
  status(): Record<string, unknown>;
}
/** Optional host policy, e.g. one native input per actor tool call. Throws PortError to refuse. */
export interface PortGate {
  authorize(kind: "path" | "click"): void;
}
export interface PortRow {
  t_ms: number;
  method: string;
  route: string;
  request: unknown;
  status: number;
  response: unknown;
  duration_ms: number;
}
export interface PortOptions {
  socketPath: string;
  backend: PortBackend;
  gate?: PortGate;
  log?: (row: PortRow) => void;
}
export const portLimits = {
  request_bytes: 64 * 1024,
  adapter_result_bytes: 256 * 1024,
  adapter_timeout_ms: 2000,
};

/** Pixels are withheld from generated MCPs: an MCP that relays images is a GUI wrapper. */
export function checkAdapterResult(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch {
    throw new PortError(
      "RESULT_INVALID",
      "adapter result must be JSON-serializable",
    );
  }
  if (Buffer.byteLength(text) > portLimits.adapter_result_bytes)
    throw new PortError(
      "RESULT_TOO_LARGE",
      "adapter result exceeds 256 KiB",
      413,
    );
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (/^\s*data:(image|video)\//i.test(item))
        throw new PortError(
          "PIXELS_WITHHELD",
          "image data URLs are not available to MCP tools",
          403,
        );
      if (item.length >= 4096 && /^[A-Za-z0-9+/=\r\n]+$/.test(item))
        throw new PortError(
          "PIXELS_WITHHELD",
          "large base64 payloads are not available to MCP tools",
          403,
        );
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object")
      Object.values(item).forEach(visit);
  };
  visit(value);
  return text;
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > portLimits.request_bytes)
      throw new PortError("REQUEST_TOO_LARGE", "request exceeds 64 KiB", 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PortError("BAD_JSON", "request body must be JSON");
  }
}
const isName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);

export async function startPort(options: PortOptions) {
  const began = performance.now();
  await rm(options.socketPath, { force: true });
  const server = createServer((request, response) => {
    const started = performance.now();
    const route = (request.url ?? "").split("?")[0];
    let input: unknown = null;
    const reply = (status: number, value: Record<string, unknown>) => {
      const text = JSON.stringify(value);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
      });
      response.end(text);
      options.log?.({
        t_ms: Math.round(started - began),
        method: request.method ?? "",
        route,
        request: input,
        status,
        response: text.length > 4096 ? { truncated_bytes: text.length } : value,
        duration_ms: Math.round(performance.now() - started),
      });
    };
    void (async () => {
      try {
        if (request.method === "GET" && route === "/v1/info")
          return reply(200, { ok: true, ...(await options.backend.info()) });
        if (request.method === "GET" && route === "/v1/status")
          return reply(200, { ok: true, ...options.backend.status() });
        if (request.method !== "POST")
          throw new PortError("NOT_FOUND", route, 404);
        input = await body(request);
        const value = (input ?? {}) as Record<string, unknown>;
        if (route === "/v1/adapter") {
          if (!isName(value.fn))
            throw new PortError(
              "BAD_REQUEST",
              "fn must be an exported adapter function name",
            );
          const result = await options.backend.adapterCall(
            value.fn,
            value.args ?? null,
          );
          const text = checkAdapterResult(result);
          return reply(200, { ok: true, value: JSON.parse(text) });
        }
        if (route === "/v1/input/path") {
          if (!Array.isArray(value.points))
            throw new PortError("INVALID_PATH", "points must be an array");
          options.gate?.authorize("path");
          return reply(200, {
            ok: true,
            ...(await options.backend.path(
              value.points as TimedPoint[],
              value.wait !== false,
            )),
          });
        }
        if (route === "/v1/input/click") {
          if (!Number.isFinite(value.x) || !Number.isFinite(value.y))
            throw new PortError("INVALID_CLICK", "x and y must be numbers");
          options.gate?.authorize("click");
          return reply(200, {
            ok: true,
            ...(await options.backend.click(
              value.x as number,
              value.y as number,
            )),
          });
        }
        throw new PortError("NOT_FOUND", route, 404);
      } catch (error) {
        const known = error instanceof PortError;
        const message = error instanceof Error ? error.message : String(error);
        const code = known
          ? error.code
          : (/^([A-Z_]{4,}):/.exec(message)?.[1] ?? "BACKEND_ERROR");
        return reply(known ? error.status : 400, {
          ok: false,
          error: {
            code,
            message: message
              .replace(/^page\.evaluate: |^jsHandle\.evaluate: /, "")
              .slice(0, 2000),
          },
        });
      }
    })();
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => done());
  });
  try {
    await chmod(options.socketPath, 0o666);
  } catch (error) {
    await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
  return {
    socketPath: options.socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(options.socketPath, { force: true });
    },
  };
}
