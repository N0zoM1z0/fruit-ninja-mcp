import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeSource } from "./bridge.js";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const upstream = {
  repository: "https://github.com/yongqixue99-hue/fruit-ninja-dojo",
  revision: "63d0af1906181cceb9486ed85cc2b65ce6e6ba0d",
  sha256: "6e072f6efc0f2bb69c98dede80ed524deda20f0004d27b7beb2e80f5c4ddf96f",
  file: "index.html",
};
export const gamePath = resolve(root, ".local/game/index.html");

export function verifyGame(bytes: Buffer): void {
  if (createHash("sha256").update(bytes).digest("hex") !== upstream.sha256)
    throw new Error(
      "Game checksum mismatch; run npm run setup to restore the pinned game.",
    );
}

export async function installGame(): Promise<string> {
  const url = `${upstream.repository.replace("github.com", "raw.githubusercontent.com")}/${upstream.revision}/${upstream.file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Game download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyGame(bytes);
  await mkdir(dirname(gamePath), { recursive: true });
  await writeFile(gamePath + ".tmp", bytes);
  await rename(gamePath + ".tmp", gamePath);
  return gamePath;
}

export async function loadGame(): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(gamePath);
  } catch {
    throw new Error("Game is not installed. Run npm run setup first.");
  }
  verifyGame(bytes);
  return bytes.toString("utf8");
}

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error(
      `Pinned game integration anchor changed: ${before.slice(0, 70)}`,
    );
  return source.replace(before, after);
}

export function instrumentGame(html: string): string {
  // Derive the round clock from integer physics ticks; repeated float additions
  // otherwise make a 20-second round run one extra tick in the upstream game.
  html = replaceOnce(
    html,
    "elapsed+=realDt;remaining=",
    "elapsed=reefTick*FIXED_STEP;remaining=",
  );
  let result = replaceOnce(
    html,
    "ambientTime+=Math.min(dt,.1);update(dt);",
    "ambientTime+=Math.min(dt,.1); // decision clock advances only in typed actions",
  );
  result = replaceOnce(
    result,
    "canvas.setPointerCapture(e.pointerId);",
    "if(e.isTrusted)canvas.setPointerCapture(e.pointerId);",
  );
  const start = result.indexOf("  function spawnWave() {"),
    end = result.indexOf("  function addText(", start);
  if (start < 0 || end < 0)
    throw new Error("Pinned game spawn block not found");
  const spawn = result
    .slice(start, end)
    .replace("function spawnWave()", "function reefOriginalSpawnWave()")
    .replaceAll("Math.random()", "reefSpawnRandom()")
    .replace(/\brand\(/g, "reefSpawnRand(")
    .replaceAll("id:reefSpawnRandom()", "id:++reefEntityId");
  result = result.slice(0, start) + spawn + result.slice(end);
  result = replaceOnce(
    result,
    "function sliceEntity(e, angle, speed = 900)",
    "function reefOriginalSliceEntity(e, angle, speed = 900)",
  );
  result = replaceOnce(
    result,
    "e.dead=true;\n        if(!e.bomb",
    "e.dead=true; reefRecordExit(e);\n        if(!e.bomb",
  );
  return replaceOnce(
    result,
    "  setSound(); updateBest(); resize(); requestAnimationFrame(frame);",
    bridgeSource +
      "\n  setSound(); updateBest(); resize(); requestAnimationFrame(frame);",
  );
}
