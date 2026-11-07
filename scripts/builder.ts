// Builder session: black-box exploration and MCP handoff through the controller tools.
//   npm run builder -- --llm-base-url http://127.0.0.1:8080/v1 --llm-model MODEL --output artifacts/build-1
//   npm run builder -- --mock fixture-positive --output artifacts/build-fixture   (scripted developer control)
import { parseArgs } from "node:util";
import { runBuilder } from "../src/evaluator/builder.js";
import { fixtureFiles } from "../dev-fixtures/fixtures.js";
import { builderScript } from "../dev-fixtures/actors.js";
import { endpoint, llmOptions } from "./llm-args.js";

const { values } = parseArgs({
  options: {
    ...llmOptions,
    output: { type: "string" },
    "max-steps": { type: "string" },
    timeout: { type: "string" },
  },
});
const files = await fixtureFiles("positive");
const { llm, close } = await endpoint(values, {
  "fixture-positive": () => builderScript(files),
});
try {
  const result = await runBuilder({
    output:
      values.output ??
      `artifacts/build/${new Date().toISOString().replace(/[:.]/g, "-")}`,
    llm,
    maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    timeoutSeconds: values.timeout ? Number(values.timeout) : undefined,
    label: values.mock ? `developer_mock:${values.mock}` : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.handoff) process.exitCode = 1;
} finally {
  await close();
}
