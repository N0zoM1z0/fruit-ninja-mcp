// Shared endpoint selection: a configurable OpenAI-compatible endpoint, or a developer mock.
import { readFileSync } from "node:fs";
import type { LlmEndpoint } from "../src/evaluator/llm.js";
import { startMockLlm, type MockPolicy } from "../src/evaluator/mock-llm.js";

export const llmOptions = {
  "llm-config": { type: "string" },
  "llm-base-url": { type: "string" },
  "llm-model": { type: "string" },
  "llm-api-key-env": { type: "string" },
  "llm-max-tokens": { type: "string" },
  "llm-temperature": { type: "string" },
  mock: { type: "string" },
} as const;

export async function endpoint(
  values: Record<string, unknown>,
  mocks: Record<string, () => MockPolicy>,
): Promise<{ llm: LlmEndpoint; close: () => Promise<void> }> {
  if (values.mock) {
    const make = mocks[values.mock as string];
    if (!make)
      throw new Error(
        `Unknown mock ${values.mock}; choose ${Object.keys(mocks).join(", ")}`,
      );
    const mock = await startMockLlm(make(), { model: `mock-${values.mock}` });
    return {
      llm: { base_url: mock.base_url, model: `mock-${values.mock}` },
      close: mock.close,
    };
  }
  // A JSON endpoint file (no secrets: the key is named by api_key_env); flags override it.
  const file: Partial<LlmEndpoint> = values["llm-config"]
    ? JSON.parse(readFileSync(values["llm-config"] as string, "utf8"))
    : {};
  const llm: LlmEndpoint = {
    ...file,
    base_url:
      (values["llm-base-url"] as string | undefined) ?? file.base_url ?? "",
    model: (values["llm-model"] as string | undefined) ?? file.model ?? "",
    api_key_env:
      (values["llm-api-key-env"] as string | undefined) ?? file.api_key_env,
    max_tokens: values["llm-max-tokens"]
      ? Number(values["llm-max-tokens"])
      : file.max_tokens,
    temperature: values["llm-temperature"]
      ? Number(values["llm-temperature"])
      : file.temperature,
  };
  if (!llm.base_url || !llm.model)
    throw new Error(
      "Give --llm-config FILE or --llm-base-url and --llm-model (OpenAI-compatible), or --mock NAME",
    );
  return { llm, close: async () => {} };
}
