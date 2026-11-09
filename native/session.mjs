import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { launchGame, GAME_SHA256 } from "./transport.mjs";
import { createServer } from "./cli.mjs";
import { createViewer } from "./viewer.mjs";
import { startRecording } from "./recording.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The evaluator owns the clock, display, recording and private native referee. */
export async function openSession({
  output,
  mode = "mcp",
  model = "Scripted MCP client",
  record = true,
  startOnFirstTool = false,
}) {
  output = path.resolve(output);
  await mkdir(output, { recursive: true });
  const viewer = await createViewer(output, mode, model);
  const implementation = {};
  await mkdir(path.join(output, "implementation"), { recursive: true });
  for (const file of await readdir(path.join(root, "native"))) {
    if (!/\.(mjs|py|c|json)$/.test(file)) continue;
    const bytes = await readFile(path.join(root, "native", file));
    implementation[file] = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(output, "implementation", file), bytes);
  }
  await writeFile(
    path.join(output, "implementation-sha256.json"),
    JSON.stringify(implementation, null, 2) + "\n",
  );
  let runtime,
    server,
    game,
    http,
    recording,
    poll,
    tick,
    closed,
    closedFlag = false;
  let state,
    resultAt,
    roundAt,
    beginRound,
    roundStartPromise,
    refereeError,
    refereeFailures = 0;
  const metadata = {
    mode,
    model,
    game_sha256: GAME_SHA256,
    planner:
      mode === "gui"
        ? "Model-chosen paths; native planner unavailable"
        : process.env.FN_PLANNER === "legacy"
          ? "greedy-chain"
          : "combo-sweep + greedy-chain",
    planner_defaults:
      mode === "mcp"
        ? {
            speed: 4200,
            lead_ms: 35,
            step_ms: 35,
            max_duration_ms: 450,
            bomb_margin: 10,
            decision_interval_ms: 40,
            physics_clock: "outer-native-clock",
          }
        : null,
    clock: "native-realtime",
    start_policy: startOnFirstTool ? "first-player-tool" : "explicit-start",
    game_fps_cap: Number(process.env.FN_GAME_FPS ?? 30),
    lp_num_threads: Number(process.env.LP_NUM_THREADS ?? 4),
    capture_fps: 30,
    panel: "none; game-only recording",
    actor_screenshot: { width: 1024, height: 768 },
    video: { width: 1024, height: 768 },
    started_at: new Date().toISOString(),
  };
  function event(event) {
    viewer.event(event);
    if (event.type === "state") {
      state = event.state;
      if (state.phase === "result") {
        resultAt ??= Date.now();
        if (game) game.inputClosed = true;
      }
    }
  }
  async function sample() {
    if (closedFlag) return state;
    const next = await game.observe();
    refereeFailures = 0;
    refereeError = undefined;
    return next;
  }
  async function close() {
    return (closed ??= (async () => {
      closedFlag = true;
      clearInterval(poll);
      await tick?.catch(() => {});
      let error;
      try {
        await viewer.close();
      } catch (e) {
        error = e;
      }
      try {
        await recording?.close();
      } catch (e) {
        error ??= e;
      }
      try {
        await server?.close();
        if (http) {
          http.closeAllConnections();
          await new Promise((r) => http.close(r));
        }
      } catch (e) {
        error ??= e;
      }
      try {
        await runtime?.close();
      } catch (e) {
        error ??= e;
      }
      if (error) throw error;
    })());
  }
  try {
    runtime = await launchGame({ root });
    ({ server, game } = await createServer(runtime, mode, {
      onEvent: event,
      preparedRound: true,
      beforeAction: startOnFirstTool ? () => beginRound() : undefined,
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await server.connect(transport);
    http = createHttpServer((request, response) => {
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      void transport.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500).end(error.message);
        else response.end();
      });
    });
    await new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    await sample();
    metadata.actor_screenshot = {
      width: state.canvas.width,
      height: state.canvas.height,
    };
    await viewer.flush?.();
    if (record)
      recording = await startRecording({
        display: runtime.display,
        output,
        gameSize: metadata.actor_screenshot,
      });
    let busy = false;
    poll = setInterval(() => {
      if (busy || closedFlag) return;
      busy = true;
      tick = sample()
        .catch((error) => {
          refereeFailures++;
          if (
            !/snapshot changed|read-failed/.test(error.message) ||
            refereeFailures >= 10
          )
            refereeError = error;
          else viewer.event({ type: "referee:retry", error: error.message });
        })
        .finally(() => {
          busy = false;
        });
    }, 200);
    const save = () =>
      writeFile(
        path.join(output, "metadata.json"),
        JSON.stringify(metadata, null, 2) + "\n",
      );
    await save();
    beginRound = () =>
      (roundStartPromise ??= (async () => {
        viewer.event({ type: "status", status: "Preparing Arcade" });
        const scene = await game.startRound();
        roundAt = Date.now();
        metadata.round_started_at = new Date(roundAt).toISOString();
        metadata.gameplay_start_video_s = recording
          ? (roundAt - recording.startedAt) / 1000
          : 0;
        metadata.initial_remaining = scene.remaining;
        metadata.initial_score = scene.score;
        viewer.event({ type: "status", status: "Model thinking" });
        await save();
        return scene;
      })());
    return {
      output,
      mode,
      game,
      viewer,
      metadata,
      url: `http://127.0.0.1:${http.address().port}/mcp`,
      get state() {
        return state;
      },
      get finished() {
        return Boolean(resultAt);
      },
      sample,
      start: () => beginRound(),
      async waitResult(timeoutSeconds = 180) {
        const readinessDeadline = Date.now() + 120000;
        while (!roundAt && Date.now() < readinessDeadline) {
          if (refereeError) throw refereeError;
          await sleep(100);
        }
        if (!roundAt)
          throw new Error(
            "Player did not start a round within readiness budget",
          );
        const deadline = roundAt + timeoutSeconds * 1000;
        while (!resultAt && Date.now() < deadline) {
          if (refereeError) throw refereeError;
          await sleep(100);
        }
        if (!resultAt)
          throw new Error("Native game did not finish within wall-time budget");
        game.inputClosed = true;
        viewer.event({ type: "status", status: "Settling result" });
        let stableAt = Date.now(),
          previous = state.score,
          settled = false;
        const settleDeadline = Date.now() + 30000;
        while (Date.now() < settleDeadline) {
          await sleep(300);
          if (refereeError) throw refereeError;
          if (state.score !== previous) {
            previous = state.score;
            stableAt = Date.now();
          }
          const replay = state.fruits.some(
            (f) =>
              !f.moving &&
              Math.abs(f.x - (state.canvas.W / 2 - 80)) < 5 &&
              Math.abs(f.y - (state.canvas.H / 2 + 116)) < 5,
          );
          if (replay && Date.now() - stableAt > 2000) {
            settled = true;
            break;
          }
        }
        if (!settled) throw new Error("Native result animation did not settle");
        metadata.native_round_wall_seconds = (resultAt - roundAt) / 1000;
        metadata.result_settle_seconds = (Date.now() - resultAt) / 1000;
        await writeFile(
          path.join(output, "result.png"),
          await game.screenshot({ emit: false }),
        );
        viewer.event({ type: "status", status: "Round complete" });
        await save();
        await sleep(700);
        return {
          status: "completed",
          score: state.score,
          remaining_game_seconds: state.remaining,
          native_round_wall_seconds: metadata.native_round_wall_seconds,
          result_settle_seconds: metadata.result_settle_seconds,
          tool_calls: viewer.snapshot().calls,
          strokes: viewer.snapshot().strokes,
          mode,
          model,
          video: path.join(output, "video.mp4"),
        };
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
