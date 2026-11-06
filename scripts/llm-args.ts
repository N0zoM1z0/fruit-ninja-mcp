// Shared endpoint selection: a configurable OpenAI-compatible endpoint, or a developer mock.
import type { LlmEndpoint } from "../src/evaluator/llm.js";
import { startMockLlm, type MockPolicy } from "../src/evaluator/mock-llm.js";

export const llmOptions = {
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
  if (!values["llm-base-url"] || !values["llm-model"])
    throw new Error(
      "Give --llm-base-url and --llm-model (OpenAI-compatible), or --mock NAME",
    );
  return {
    llm: {
      base_url: values["llm-base-url"] as string,
      model: values["llm-model"] as string,
      api_key_env: values["llm-api-key-env"] as string | undefined,
      max_tokens: values["llm-max-tokens"]
        ? Number(values["llm-max-tokens"])
        : undefined,
      temperature: values["llm-temperature"]
        ? Number(values["llm-temperature"])
        : undefined,
    },
    close: async () => {},
  };
}
