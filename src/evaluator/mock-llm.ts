// PRIVATE, test/development only: an OpenAI-compatible endpoint that answers with scripted or
// programmatic tool calls. It performs no inference and calls no external service.
import { createServer } from "node:http";

export interface MockCall {
  name: string;
  arguments?: Record<string, unknown>;
}
export interface MockReply {
  content?: string;
  tool_calls?: MockCall[];
}
export interface MockContext {
  step: number;
  messages: any[];
  tools: string[];
  /** Text of the tool results returned since the previous assistant turn. */
  results: string[];
  /** Parsed JSON of the last tool result, or null. */
  last: any;
}
export type MockPolicy = (
  context: MockContext,
) => MockReply | Promise<MockReply>;

/** Replay fixed steps. A function step can inspect the previous results; null ends the script. */
export function scripted(
  steps: (
    MockCall | MockCall[] | ((c: MockContext) => MockCall | MockCall[] | null)
  )[],
  final = "done",
): MockPolicy {
  let index = 0;
  return (context) => {
    while (index < steps.length) {
      const step = steps[index++];
      const value = typeof step === "function" ? step(context) : step;
      if (value === null) break;
      return { tool_calls: Array.isArray(value) ? value : [value] };
    }
    return { content: final };
  };
}

export async function startMockLlm(
  policy: MockPolicy,
  options: { apiKey?: string; model?: string } = {},
) {
  const requests: any[] = [];
  let step = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", async () => {
      const reply = (status: number, value: unknown) => {
        const text = JSON.stringify(value);
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(text);
      };
      if (request.url !== "/v1/chat/completions" || request.method !== "POST")
        return reply(404, { error: "not found" });
      if (
        options.apiKey &&
        request.headers.authorization !== `Bearer ${options.apiKey}`
      )
        return reply(401, { error: "unauthorized" });
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({
          model: body.model,
          tools: (body.tools ?? []).map((t: any) => t.function.name),
          messages: body.messages.length,
          authorized: true,
        });
        const messages: any[] = body.messages;
        let lastAssistant = messages.length - 1;
        while (
          lastAssistant >= 0 &&
          messages[lastAssistant].role !== "assistant"
        )
          lastAssistant--;
        const results = messages
          .slice(lastAssistant + 1)
          .filter((m) => m.role === "tool")
          .map((m) => String(m.content));
        let last: any = null;
        try {
          last = results.length ? JSON.parse(results.at(-1)!) : null;
        } catch {
          last = null;
        }
        const answer = await policy({
          step: ++step,
          messages,
          tools: (body.tools ?? []).map((t: any) => t.function.name),
          results,
          last,
        });
        const calls = (answer.tool_calls ?? []).map((call, i) => ({
          id: `call_${step}_${i}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        }));
        reply(200, {
          id: `chatcmpl-mock-${step}`,
          object: "chat.completion",
          created: 0,
          model: options.model ?? body.model,
          choices: [
            {
              index: 0,
              finish_reason: calls.length ? "tool_calls" : "stop",
              message: {
                role: "assistant",
                content: answer.content ?? null,
                ...(calls.length ? { tool_calls: calls } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (error) {
        reply(500, { error: String(error) });
      }
    });
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", () => done()),
  );
  const address = server.address() as { port: number };
  return {
    base_url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
