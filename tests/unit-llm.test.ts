import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runAgent } from "../src/evaluator/llm.js";
import { scripted, startMockLlm } from "../src/evaluator/mock-llm.js";

test("agent loop drives tools through an OpenAI-compatible endpoint, traces everything and never logs the key", async () => {
  const canary = "fnsm-canary-" + Math.random().toString(16).slice(2);
  process.env.FNSM_TEST_KEY = canary;
  let screenshotsSeen = 0;
  const mock = await startMockLlm(
    scripted([
      { name: "echo", arguments: { value: 3 } },
      ({ last }) => ({ name: "echo", arguments: { value: last.value + 1 } }),
      { name: "picture" },
      { name: "missing_tool" },
      { name: "echo", arguments: "not-an-object" as any },
    ]),
    { apiKey: canary },
  );
  const traceDir = await mkdtemp(resolve(tmpdir(), "fnsm-llm-"));
  const calls: string[] = [];
  try {
    const result = await runAgent({
      llm: {
        base_url: mock.base_url,
        model: "mock",
        api_key_env: "FNSM_TEST_KEY",
      },
      system: "system prompt",
      user: "user prompt",
      traceDir,
      maxSteps: 20,
      deadlineMs: 20_000,
      vision: true,
      session: {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
            },
          },
          { name: "picture", inputSchema: { type: "object", properties: {} } },
        ],
        call: async (name, args): Promise<CallToolResult> => {
          calls.push(name);
          if (name === "picture") {
            screenshotsSeen++;
            return {
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: Buffer.from("png-bytes").toString("base64"),
                },
              ],
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(args) }] };
        },
      },
    });
    assert.equal(result.stop_reason, "final_message");
    assert.deepEqual(calls, ["echo", "echo", "picture"]);
    assert.equal(result.tool_calls, 5);
    assert.equal(
      result.tool_errors,
      2,
      "unknown tool and invalid arguments are tool errors, not crashes",
    );
    assert.equal(screenshotsSeen, 1);
    assert.ok(mock.requests.every((r) => r.authorized && r.model === "mock"));
    const files = await readdir(traceDir);
    assert.deepEqual(files.sort(), ["llm.jsonl", "prompt.json", "tools.jsonl"]);
    const tools = (await readFile(resolve(traceDir, "tools.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(
      tools[1].arguments.value,
      4,
      "the second call used the first result",
    );
    assert.ok(tools[2].result.content[0].sha256, "images are hashed in traces");
    const llm = await readFile(resolve(traceDir, "llm.jsonl"), "utf8");
    assert.ok(
      llm.includes("sha256:"),
      "image parts sent to the model are redacted in traces",
    );
    for (const file of files)
      assert.ok(
        !(await readFile(resolve(traceDir, file), "utf8")).includes(canary),
        `${file} leaks the key`,
      );
  } finally {
    await mock.close();
    delete process.env.FNSM_TEST_KEY;
  }
});

test("a wrong key is rejected by the endpoint and recorded as an LLM error", async () => {
  process.env.FNSM_TEST_KEY = "wrong";
  const mock = await startMockLlm(scripted([]), { apiKey: "right" });
  try {
    const result = await runAgent({
      llm: {
        base_url: mock.base_url,
        model: "mock",
        api_key_env: "FNSM_TEST_KEY",
      },
      system: "s",
      user: "u",
      traceDir: await mkdtemp(resolve(tmpdir(), "fnsm-llm-")),
      maxSteps: 3,
      deadlineMs: 10_000,
      session: { tools: [], call: async () => ({ content: [] }) },
    });
    assert.equal(result.stop_reason, "llm_error");
    assert.match(result.error!, /HTTP 401/);
  } finally {
    await mock.close();
    delete process.env.FNSM_TEST_KEY;
  }
});
