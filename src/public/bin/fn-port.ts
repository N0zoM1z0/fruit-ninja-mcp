#!/usr/bin/env node
// PUBLIC builder tool: run the packaged game and expose the same game port your MCP gets at
// play time (adapter calls + native input). There is no referee and no gameplay MCP here.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DevGame } from "../devgame.js";
import { startPort } from "../port.js";

const { values } = parseArgs({
  options: {
    socket: { type: "string", default: "/work/port.sock" },
    adapter: { type: "string" },
    game: {
      type: "string",
      default: `${process.env.FN_TARGET ?? "/opt/target"}/game/index.html`,
    },
    browser: {
      type: "string",
      default: process.env.FRUIT_NINJA_CHROMIUM ?? "/usr/bin/chromium",
    },
    mode: { type: "string", default: "arcade" },
    seed: { type: "string", default: "1" },
    duration: { type: "string", default: "60" },
    profile: { type: "string", default: "standard" },
    log: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});
const game = await DevGame.launch({
  html: await readFile(values.game!, "utf8"),
  executablePath: values.browser!,
  headless: !values.headed,
  mode: values.mode as "arcade",
  seed: Number(values.seed),
  duration_seconds: Number(values.duration),
  profile: values.profile === "async" ? "async" : "standard",
  adapterSource: values.adapter
    ? await readFile(values.adapter, "utf8")
    : undefined,
});
const port = await startPort({
  socketPath: values.socket!,
  backend: game,
  log: values.log ? (row) => console.error(JSON.stringify(row)) : undefined,
});
console.log(
  JSON.stringify({
    socket: port.socketPath,
    adapter_exports: game.exports,
    lockdown: game.lockdown,
  }),
);
const stop = async () => {
  await port.close();
  await game.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
