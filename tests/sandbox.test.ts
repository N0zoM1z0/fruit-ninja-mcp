// Docker-level isolation and exploration checks. Requires FNSM_DOCKER=1 (set by `make test`).
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { root } from "../src/upstream.js";
import { BuilderController } from "../src/evaluator/builder.js";
import {
  BuilderSandbox,
  docker,
  hardening,
  images,
  newRunId,
  removeRunContainers,
} from "../src/evaluator/sandbox.js";
import { forbiddenMarkers } from "../src/evaluator/package.js";

const enabled = process.env.FNSM_DOCKER === "1";
const scanCommand = (markers: string[]) =>
  `grep -rIl ${markers.map((m) => `-e '${m}'`).join(" ")} /opt /etc /home /usr/local /node_modules/ 2>/dev/null | head -20; ls -d /workspace /artifacts /repo ${root} 2>/dev/null; true`;

test(
  "builder and play images contain no private markers or repository paths",
  { skip: !enabled },
  async () => {
    for (const image of [images().builder, images().play]) {
      const result = await docker(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "sh",
          image,
          "-c",
          scanCommand(forbiddenMarkers),
        ],
        { timeoutMs: 180_000 },
      );
      assert.equal(result.exit_code, 0, result.stderr);
      assert.equal(
        result.stdout.trim(),
        "",
        `${image} contains private material:\n${result.stdout}`,
      );
    }
  },
);

test(
  "builder sandbox: unprivileged, offline, no secrets; inspection, Chromium and the dev port work",
  { skip: !enabled },
  async () => {
    process.env.FNSM_CANARY_KEY = "fnsm-canary-sandbox";
    const runId = newRunId("t");
    const sandbox = await BuilderSandbox.start(runId);
    const output = await mkdtemp(resolve(root, "artifacts/test-sandbox-"));
    const controller = new BuilderController(sandbox, output);
    try {
      assert.match((await sandbox.exec(["id"])).stdout, /uid=10001/);
      const env = await sandbox.exec(["env"]);
      assert.ok(
        !env.stdout.includes("fnsm-canary") &&
          !/KEY|TOKEN|SECRET/i.test(env.stdout),
        env.stdout,
      );
      const net = await sandbox.exec(
        [
          "node",
          "-e",
          "fetch('https://example.com').then(()=>console.log('OPEN'),e=>console.log('BLOCKED',e.cause?.code??e.message))",
        ],
        { timeoutMs: 20_000 },
      );
      assert.match(net.stdout, /BLOCKED/);
      assert.notEqual(
        (await sandbox.exec(["touch", "/opt/target/x"])).exit_code,
        0,
        "target is read-only",
      );
      const symbols = JSON.parse(
        (await controller.inspect("symbols", ["1"])).stdout,
      );
      assert.ok(
        symbols.some(
          (s: any) =>
            s.name === "sliceEntity" || s.name === "reefOriginalSliceEntity",
        ),
      );
      assert.ok(symbols.some((s: any) => s.name === "entities"));
      await assert.rejects(
        controller.writeFile("/work/x", "x", "utf8", false),
        /restricted/,
      );
      await assert.rejects(controller.build(), /incomplete deliverable/);
      // Exploration with the sandbox Chromium against the packaged game.
      const probe = `import { chromium } from "playwright-core"; import { readFileSync } from "node:fs";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1440, height: 960 } });
await p.setContent(readFileSync("/opt/target/game/index.html", "utf8"));
const shot = await p.screenshot();
console.log(JSON.stringify({ prepare: await p.evaluate(() => typeof window.__fnPrepare), referee: await p.evaluate(() => Object.getOwnPropertyNames(window).filter(n => /referee|fruitNinjaMcp/i.test(n))), png: shot.length }));
await b.close();`;
      await controller.writeFile("/output/probe.mjs", probe, "utf8", false);
      const explored = await sandbox.exec(["node", "/output/probe.mjs"], {
        timeoutMs: 60_000,
      });
      assert.equal(explored.exit_code, 0, explored.stderr);
      const seen = JSON.parse(explored.stdout.trim().split("\n").at(-1)!);
      assert.equal(seen.prepare, "function");
      assert.deepEqual(seen.referee, []);
      assert.ok(seen.png > 10_000);
      // Dev port serves the same API as play time.
      const port = await sandbox.exec(
        [
          "sh",
          "-c",
          "node /opt/toolchain/fn/bin/fn-port.js --socket /work/p.sock > /work/port.log 2>&1 & PID=$!; for i in $(seq 1 60); do [ -S /work/p.sock ] && break; sleep 0.25; done; node -e \"import('/opt/toolchain/fn/port-client.js').then(async m => { const c = new m.GamePortClient('/work/p.sock'); console.log(JSON.stringify(await c.info())); process.exit(0); })\"; kill $PID",
        ],
        { timeoutMs: 60_000 },
      );
      const info = JSON.parse(port.stdout.trim().split("\n").at(-1)!);
      assert.equal(info.ok, true);
      assert.equal(info.viewport.width, 1440);
    } finally {
      await sandbox.stop();
      delete process.env.FNSM_CANARY_KEY;
    }
  },
);

test(
  "play sandbox: offline, unprivileged, no browser, no game files, no host artifacts",
  { skip: !enabled },
  async () => {
    const runId = newRunId("t");
    const empty = await mkdtemp(resolve(root, "artifacts/test-play-"));
    await mkdir(resolve(empty, "p"));
    try {
      const result = await docker(
        [
          "run",
          "--rm",
          "--name",
          `fnsm-p-${runId}`,
          ...hardening,
          "--tmpfs",
          "/tmp",
          "-v",
          `${resolve(empty, "p")}:/run/fn:ro`,
          "--entrypoint",
          "sh",
          images().play,
          "-c",
          "id; command -v chromium || echo NO_BROWSER; ls /opt; ls /run/fn; touch /run/fn/x 2>/dev/null && echo WRITABLE || echo READONLY; node -e \"fetch('https://example.com').then(()=>console.log('OPEN'),()=>console.log('BLOCKED'))\"",
        ],
        { timeoutMs: 60_000 },
      );
      assert.match(result.stdout, /uid=10001/);
      assert.match(result.stdout, /NO_BROWSER/);
      assert.match(result.stdout, /READONLY/);
      assert.match(result.stdout, /BLOCKED/);
      assert.ok(
        !/\btarget\b/.test(result.stdout),
        "no packaged game in the play image",
      );
    } finally {
      await removeRunContainers(runId);
    }
  },
);
