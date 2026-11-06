// PRIVATE: one OpenAI-compatible tool-calling loop for builder, GUI-play and MCP-play.
// Credentials stay in this host process: they are read from a named environment variable,
// sent only as the Authorization header, and never written to traces or sandboxes.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { sha256 } from "../upstream.js";

export interface LlmEndpoint {
  base_url: string;
  model: string;
  api_key_env?: string;
  max_tokens?: number;
  temperature?: number;
  request_timeout_ms?: number;
  extra_body?: Record<string, unknown>;
}
export interface ToolSession {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}
export interface AgentOptions {
  llm: LlmEndpoint;
  system: string;
  user: string;
  session: ToolSession;
  traceDir: string;
  maxSteps: number;
  deadlineMs: number;
  /** Send tool-result images to the model as user image parts (GUI screenshots). */
  vision?: boolean;
  /** Keep only this many most recent images in the conversation. */
  keepImages?: number;
  shouldStop?: () => boolean;
}
export interface AgentResult {
  steps: number;
  tool_calls: number;
  tool_errors: number;
  stop_reason:
    "final_message" | "max_steps" | "deadline" | "stopped" | "llm_error";
  final_message: string | null;
  error?: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  llm_latency_ms: number[];
}
const functionName = (name: string) =>
  name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
const textOf = (result: CallToolResult) =>
  (result.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
/** Trace form of a tool result: images are replaced by their hash and size. */
export function traceable(result: CallToolResult) {
  return {
    ...result,
    content: (result.content ?? []).map((b: any) =>
      b.type === "image"
        ? {
            type: "image",
            mimeType: b.mimeType,
            sha256: sha256(Buffer.from(b.data, "base64")),
            bytes: Buffer.from(b.data, "base64").length,
          }
        : b,
    ),
  };
}
const redactImages = (messages: any[]) =>
  messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((p: any) =>
            p.type === "image_url"
              ? {
                  type: "image_url",
                  image_url: { url: `sha256:${sha256(p.image_url.url)}` },
                }
              : p,
          ),
        }
      : m,
  );

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  await mkdir(options.traceDir, { recursive: true });
  const llmTrace = resolve(options.traceDir, "llm.jsonl"),
    toolTrace = resolve(options.traceDir, "tools.jsonl");
  const epoch = performance.now();
  const now = () => Math.round(performance.now() - epoch);
  const byFunction = new Map(
    options.session.tools.map((t) => [functionName(t.name), t.name]),
  );
  const tools = options.session.tools.map((t) => ({
    type: "function",
    function: {
      name: functionName(t.name),
      description: t.description ?? "",
      parameters: t.inputSchema,
    },
  }));
  await writeFile(
    resolve(options.traceDir, "prompt.json"),
    JSON.stringify(
      {
        endpoint: {
          ...options.llm,
          api_key_env: options.llm.api_key_env ?? null,
        },
        system: options.system,
        user: options.user,
        tools,
      },
      null,
      2,
    ) + "\n",
  );
  const key = options.llm.api_key_env
    ? process.env[options.llm.api_key_env]
    : undefined;
  if (options.llm.api_key_env && !key)
    throw new Error(
      `Environment variable ${options.llm.api_key_env} is not set`,
    );
  const messages: any[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];
  const result: AgentResult = {
    steps: 0,
    tool_calls: 0,
    tool_errors: 0,
    stop_reason: "max_steps",
    final_message: null,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    llm_latency_ms: [],
  };
  const deadline = performance.now() + options.deadlineMs;
  while (result.steps < options.maxSteps) {
    if (options.shouldStop?.()) {
      result.stop_reason = "stopped";
      break;
    }
    if (performance.now() >= deadline) {
      result.stop_reason = "deadline";
      break;
    }
    result.steps++;
    const body = {
      model: options.llm.model,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: options.llm.max_tokens ?? 4096,
      ...(options.llm.temperature === undefined
        ? {}
        : { temperature: options.llm.temperature }),
      ...(options.llm.extra_body ?? {}),
    };
    const text = JSON.stringify(body);
    await appendFile(
      llmTrace,
      JSON.stringify({
        kind: "request",
        step: result.steps,
        t_ms: now(),
        body_sha256: sha256(text),
        body: { ...body, messages: redactImages(messages) },
      }) + "\n",
    );
    let reply: any;
    const started = performance.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(
          options.llm.base_url.replace(/\/$/, "") + "/chat/completions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(key ? { authorization: `Bearer ${key}` } : {}),
            },
            body: text,
            signal: AbortSignal.timeout(
              Math.floor(
                Math.min(
                  options.llm.request_timeout_ms ?? 300_000,
                  Math.max(1000, deadline - performance.now()),
                ),
              ),
            ),
          },
        );
        const raw = await response.text();
        if (!response.ok) {
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < 2
          ) {
            await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
            continue;
          }
          throw new Error(`LLM HTTP ${response.status}: ${raw.slice(0, 500)}`);
        }
        reply = JSON.parse(raw);
        break;
      } catch (error) {
        if (attempt >= 2 || performance.now() >= deadline) {
          result.stop_reason = "llm_error";
          result.error = String(error);
          await appendFile(
            llmTrace,
            JSON.stringify({
              kind: "error",
              step: result.steps,
              t_ms: now(),
              error: String(error),
            }) + "\n",
          );
          return result;
        }
      }
    }
    const latency = Math.round(performance.now() - started);
    result.llm_latency_ms.push(latency);
    await appendFile(
      llmTrace,
      JSON.stringify({
        kind: "response",
        step: result.steps,
        t_ms: now(),
        latency_ms: latency,
        body: reply,
      }) + "\n",
    );
    for (const k of [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
    ] as const)
      result.usage[k] += Number(reply?.usage?.[k] ?? 0);
    const message = reply?.choices?.[0]?.message;
    if (!message) {
      result.stop_reason = "llm_error";
      result.error = "response has no message";
      return result;
    }
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    });
    if (!message.tool_calls?.length) {
      result.stop_reason = "final_message";
      result.final_message = message.content ?? null;
      break;
    }
    const images: { name: string; data: string; mimeType: string }[] = [];
    for (const call of message.tool_calls) {
      const name = byFunction.get(call.function?.name) ?? call.function?.name;
      let args: Record<string, unknown> = {};
      let output: CallToolResult;
      const callStarted = performance.now();
      try {
        args = call.function?.arguments
          ? JSON.parse(call.function.arguments)
          : {};
        if (!byFunction.has(call.function?.name))
          throw new Error(`Unknown tool ${call.function?.name}`);
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Tool arguments must be a JSON object");
        output = await options.session.call(name, args);
      } catch (error) {
        output = {
          isError: true,
          content: [
            {
              type: "text",
              text: String(error instanceof Error ? error.message : error),
            },
          ],
        };
      }
      result.tool_calls++;
      if (output.isError) result.tool_errors++;
      await appendFile(
        toolTrace,
        JSON.stringify({
          step: result.steps,
          call_id: call.id,
          name,
          arguments: args,
          started_ms: Math.round(callStarted - epoch),
          duration_ms: Math.round(performance.now() - callStarted),
          is_error: !!output.isError,
          result: traceable(output),
        }) + "\n",
      );
      for (const block of output.content ?? [])
        if (block.type === "image")
          images.push({
            name,
            data: (block as any).data,
            mimeType: (block as any).mimeType,
          });
      const textResult =
        textOf(output) || (images.length ? "(image returned)" : "(no text)");
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: textResult.slice(0, 200_000),
      });
      if (options.shouldStop?.()) break;
    }
    if (options.vision && images.length) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Image result from ${images.map((i) => i.name).join(", ")}.`,
          },
          ...images.map((i) => ({
            type: "image_url",
            image_url: { url: `data:${i.mimeType};base64,${i.data}` },
          })),
        ],
      });
      // Bound context growth: drop older images, keep their positions as text.
      const keep = options.keepImages ?? 2;
      let seen = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!Array.isArray(m.content)) continue;
        m.content = m.content.map((p: any) =>
          p.type === "image_url"
            ? ++seen > keep
              ? { type: "text", text: "[older image omitted]" }
              : p
            : p,
        );
      }
    }
  }
  return result;
}
