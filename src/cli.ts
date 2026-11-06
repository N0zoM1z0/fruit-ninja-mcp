#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { GameRuntime, browserExecutable } from "./runtime.js";
import { installGame, loadGame, root } from "./upstream.js";
import { serve } from "./server.js";
import type { GameMode } from "./types.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      artifacts: { type: "string" },
      browser: { type: "string" },
      headed: { type: "boolean", default: false },
      locked: { type: "boolean", default: false },
      mode: { type: "string", default: "arcade" },
      seed: { type: "string", default: "42" },
      duration: { type: "string" },
      interface: { type: "string", default: "mcp" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help) {
    console.log(
      "fruit-ninja-mcp setup | serve [--interface mcp|gui] [--headed] [--artifacts DIR] [--mode arcade --seed 42 --duration 60] | play | codex-config",
    );
    return;
  }
  if (command === "setup") {
    console.log(await installGame());
    return;
  }
  if (command === "codex-config") {
    console.log(
      `model = "gpt-6.1-terra"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.fruit_ninja]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([resolve(root, "dist/cli.js"), "serve"])}\nstartup_timeout_sec = 30\ntool_timeout_sec = 30\ndefault_tools_approval_mode = "auto"`,
    );
    return;
  }
  if (command === "play") {
    const browser = await chromium.launch({
      headless: false,
      executablePath: await browserExecutable(values.browser),
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });
    await page.setContent(await loadGame(), { waitUntil: "load" });
    await new Promise<void>((done) =>
      browser.once("disconnected", () => done()),
    );
    return;
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}`);
  if (!["classic", "arcade", "zen"].includes(values.mode!))
    throw new Error("Choose classic, arcade or zen");
  const runtime = await GameRuntime.launch({
    browser: values.browser,
    headless: !values.headed,
    artifacts: values.artifacts,
  });
  try {
    await runtime.prepare({
      mode: values.mode as GameMode,
      seed: Number(values.seed),
      ...(values.duration ? { duration_seconds: Number(values.duration) } : {}),
    });
    if (!["mcp", "gui"].includes(values.interface!))
      throw new Error("Choose mcp or gui interface");
    await serve(runtime, values.interface as "mcp" | "gui");
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
