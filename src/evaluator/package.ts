// PRIVATE: build the packaged game (the builder's black-box target) and the minimal Docker
// build contexts for the builder and play images, then scan them for private material.
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadGame, packagedGame, root, sha256, upstream } from "../upstream.js";
import { privateMarkers } from "./referee.js";
import { viewport } from "../public/devgame.js";

export const packageDir = resolve(root, ".local/package");
export const contextDir = resolve(root, ".local/context");
/** Strings that must never reach an agent-visible image or sandbox. */
export const forbiddenMarkers = [
  ...privateMarkers,
  "DEVELOPER FIXTURE",
  "fnsm-canary-",
];

export async function writePackage() {
  const html = packagedGame(await loadGame());
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(resolve(packageDir, "game"), { recursive: true });
  await writeFile(resolve(packageDir, "game/index.html"), html);
  const manifest = {
    software: "Fruit Ninja Dojo (browser remake), evaluation build",
    kind: "single-page browser game (HTML/CSS/JavaScript, Canvas 2D)",
    upstream: {
      repository: upstream.repository,
      revision: upstream.revision,
      file: upstream.file,
      sha256: upstream.sha256,
      license: upstream.license,
    },
    packaged: {
      file: "game/index.html",
      sha256: sha256(html),
      bytes: Buffer.byteLength(html),
    },
    launch: {
      browser:
        "Chromium (/usr/bin/chromium), headless, --no-sandbox, no network",
      viewport,
      device_scale_factor: 1,
      load: "page.setContent(game/index.html); host calls window.__fnPrepare({mode, seed, duration_seconds}) once; host applies lockdown; host injects your adapter.",
    },
    evaluation_rules: [
      "Realtime: 120 Hz physics ticks follow the monotonic wall clock; nothing pauses or advances time.",
      "One prepared round per session. Pause, home, reset and restart are disabled.",
      "Gameplay accepts trusted (native) pointer input only; dispatched DOM events are ignored.",
      "Only a native click on the start button starts the round.",
      "Mode, motion effects and arena geometry are fixed once prepared.",
      "Content-Security-Policy forbids network access and eval/new Function in the page.",
    ],
  };
  await writeFile(
    resolve(packageDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  for (const name of ["CONTRACT.md", "PORT.md", "NOTICE.md"])
    await cp(resolve(root, "sandbox/public", name), resolve(packageDir, name));
  return { dir: packageDir, manifest };
}

async function copyPublic(destination: string) {
  const source = resolve(root, "dist/public");
  await stat(resolve(source, "port.js")).catch(() => {
    throw new Error("dist/public is missing; run npm run build first");
  });
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts"),
  });
}
export async function assembleContexts() {
  await rm(contextDir, { recursive: true, force: true });
  for (const role of ["builder", "play"]) {
    const dir = resolve(contextDir, role);
    await mkdir(resolve(dir, "toolchain"), { recursive: true });
    for (const name of ["package.json", "package-lock.json"])
      await cp(
        resolve(root, "sandbox/toolchain", name),
        resolve(dir, "toolchain", name),
      );
    await copyPublic(resolve(dir, "fn"));
    if (role === "builder")
      await cp(packageDir, resolve(dir, "target"), { recursive: true });
  }
  return contextDir;
}

export async function scanTree(directory: string, markers = forbiddenMarkers) {
  const hits: { file: string; marker: string }[] = [];
  let files = 0;
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name),
        info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else {
        files++;
        const text = (await readFile(path)).toString("latin1");
        for (const marker of markers)
          if (text.includes(marker))
            hits.push({ file: relative(directory, path), marker });
      }
    }
  };
  await walk(directory);
  return { directory, files, hits };
}
