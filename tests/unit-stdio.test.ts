import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StrictStdioTransport } from "../src/evaluator/stdio.js";

test(
  "stdio launcher preserves the Docker API version without forwarding credentials",
  { timeout: 5000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "fnsm-stdio-"));
    const names = ["DOCKER_API_VERSION", "DEEPSEEK_API_KEY"] as const;
    const previous = names.map((name) => process.env[name]);
    const transport = new StrictStdioTransport(
      process.execPath,
      [
        "-e",
        `console.log(JSON.stringify({jsonrpc:"2.0",method:"probe",params:{api:process.env.DOCKER_API_VERSION,credential_present:!!process.env.DEEPSEEK_API_KEY}}))`,
      ],
      join(directory, "stdio.jsonl"),
      join(directory, "stderr.log"),
    );
    try {
      process.env.DOCKER_API_VERSION = "1.41";
      process.env.DEEPSEEK_API_KEY = "fnsm-canary-stdio-secret";
      const message = new Promise<any>((resolve, reject) => {
        transport.onmessage = resolve;
        transport.onerror = reject;
        transport.onclose = () =>
          reject(new Error("probe exited without a message"));
      });
      await transport.start();
      assert.deepEqual((await message).params, {
        api: "1.41",
        credential_present: false,
      });
    } finally {
      await transport.close();
      for (const [i, name] of names.entries()) {
        if (previous[i] === undefined) delete process.env[name];
        else process.env[name] = previous[i];
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
