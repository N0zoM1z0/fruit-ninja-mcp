import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/evaluator/llm.js";

/** Endpoint shaped like the DeepSeek V4.1 Flash server: reasoning_content and nested usage. */
async function fakeEndpoint(replies: ((body: any) => any)[]) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      const make = replies[Math.min(bodies.length - 1, replies.length - 1)];
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(make(body)));
    });
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", () => done()),
  );
  const port = (server.address() as { port: number }).port;
  return {
    base_url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((d) => server.close(() => d())),
  };
}
const reply = (message: any, finish: string) => ({
  choices: [
    {
      index: 0,
      finish_reason: finish,
      message: { role: "assistant", ...message },
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    reasoning_tokens: 3,
    prompt_tokens_details: { cached_tokens: 4 },
  },
});

test("endpoint integration: reasoning is interleaved, truncation is not final, usage and long outputs are bounded", async () => {
  const fake = await fakeEndpoint([
    () =>
      reply(
        {
          content: "",
          reasoning_content: "think-1",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "big", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      ),
    () => reply({ content: "", reasoning_content: "think-2" }, "length"),
    () =>
      reply(
        {
          content: "",
          reasoning_content: "think-3",
          tool_calls: [
            {
              id: "c2",
              type: "function",
              function: { name: "big", arguments: '{"cut' },
            },
          ],
        },
        "length",
      ),
    () => reply({ content: "done", reasoning_content: "think-4" }, "stop"),
  ]);
  const traceDir = await mkdtemp(resolve(tmpdir(), "fnsm-endpoint-"));
  try {
    const result = await runAgent({
      llm: {
        base_url: fake.base_url,
        model: "m",
        max_tokens: 2048,
        temperature: 0.3,
        extra_body: { top_p: 0.9, stream: false, reasoning_effort: "high" },
      },
      system: "s",
      user: "u",
      traceDir,
      maxSteps: 10,
      deadlineMs: 10_000,
      maxToolResultChars: 100,
      compaction: { triggerChars: 1, targetChars: 1, keepRecent: 0 },
      session: {
        tools: [
          { name: "big", inputSchema: { type: "object", properties: {} } },
        ],
        call: async () => ({
          content: [{ type: "text", text: "x".repeat(5000) }],
        }),
      },
    });
    assert.equal(result.stop_reason, "final_message");
    assert.equal(result.final_message, "done");
    assert.equal(result.truncations, 2);
    assert.deepEqual(result.finish_reasons, {
      tool_calls: 1,
      length: 2,
      stop: 1,
    });
    assert.equal(result.usage.reasoning_tokens, 12);
    assert.equal(result.usage["prompt_tokens_details.cached_tokens"], 16);
    assert.equal(
      result.tool_errors,
      1,
      "cut-off tool arguments become a tool error, not a crash",
    );
    const second = fake.bodies[1];
    assert.equal(second.top_p, 0.9);
    assert.equal(second.reasoning_effort, "high");
    assert.equal(second.max_tokens, 2048);
    assert.equal(
      second.messages.find((m: any) => m.role === "assistant")
        .reasoning_content,
      "think-1",
    );
    const tool = second.messages.find((m: any) => m.role === "tool").content;
    assert.ok(
      tool.length < 500 && tool.includes("truncated to 100 of 5000"),
      "long outputs are capped for the model",
    );
    assert.ok(
      fake.bodies[2].messages
        .at(-1)
        .content.includes("cut off at the max_tokens limit (2048)"),
    );
    assert.ok(result.compactions >= 1);
    const full = (
      await readFile(resolve(traceDir, "tools.jsonl"), "utf8")
    ).split("\n")[0];
    assert.ok(
      full.includes("x".repeat(5000)),
      "the trace keeps the full tool output",
    );
  } finally {
    await fake.close();
  }
});
