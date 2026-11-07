import {
  chromium,
  type Browser,
  type JSHandle,
  type Page,
} from "playwright-core";
import { access, appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadGame, packagedGame, sha256, upstream } from "./upstream.js";
import { refereedGame } from "./evaluator/referee.js";
import {
  executeTimedPath,
  validatePath,
  type PointerSample,
} from "./public/executor.js";
import { adapterExpression, lockdownSource } from "./public/lockdown.js";
import type {
  ActionResult,
  GameEvent,
  NewGame,
  Scene,
  Swipe,
  TimedPoint,
  Wait,
  Observe,
  ObservationResult,
  ActionStatus,
  SubmittedAction,
} from "./types.js";

export { validatePath };
export const viewport = { width: 1440, height: 960 };
export interface RuntimeOptions {
  browser?: string;
  artifacts?: string;
  headless?: boolean;
  recordVideo?: boolean;
}
export interface Integrity {
  violations: { kind: string; detail: unknown; tick: number; at_ms: number }[];
  unattributed_slices: number;
  lockdown: boolean;
  baseline: unknown;
  config: { mode: string; duration_seconds: number | null };
}
export function sceneHash(scene: Scene): string {
  return createHash("sha256").update(JSON.stringify(scene)).digest("hex");
}
export async function browserExecutable(explicit?: string): Promise<string> {
  for (const path of [
    explicit,
    process.env.FRUIT_NINJA_CHROMIUM,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    if (
      path &&
      (await access(path).then(
        () => true,
        () => false,
      ))
    )
      return path;
  }
  throw new Error("Chromium was not found. Set FRUIT_NINJA_CHROMIUM.");
}
export const chromiumArgs = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

/** Evaluator-owned game. The referee is reachable only through a private CDP handle. */
export class GameRuntime {
  private fatalAdapterError: Error | null = null;
  get failureReason(): string | null {
    return this.fatalAdapterError?.message ?? null;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private persistence: Promise<unknown> = Promise.resolve();
  private closed = false;
  private telemetryTimer?: NodeJS.Timeout;
  private telemetryBusy = false;
  private finalSaved = false;
  private frame = 0;
  private lastCaptureAt?: number;
  private actionId = 0;
  private activeAction?: number;
  private previousAction: ActionStatus | null = null;
  private canvasRect!: { x: number; y: number; width: number; height: number };
  private arena = { width: 0, height: 0 };
  private referee!: JSHandle;
  private adapter?: JSHandle;
  private readonly epoch = performance.now();
  lockdown?: Record<string, unknown>;
  adapterExports: string[] = [];
  private constructor(
    readonly browser: Browser,
    readonly page: Page,
    readonly artifacts?: string,
  ) {}

  static async launch(options: RuntimeOptions = {}): Promise<GameRuntime> {
    if (options.recordVideo && !options.artifacts)
      throw new Error("Video recording requires an artifacts directory");
    const original = await loadGame();
    const { html, key } = refereedGame(original);
    const browser = await chromium.launch({
      executablePath: await browserExecutable(options.browser),
      headless: options.headless ?? true,
      args: chromiumArgs,
    });
    try {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        ...(options.recordVideo
          ? {
              recordVideo: {
                dir: resolve(options.artifacts!, "raw-video"),
                size: viewport,
              },
            }
          : {}),
      });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      const runtime = new GameRuntime(
        browser,
        page,
        options.artifacts && resolve(options.artifacts),
      );
      page.on(
        "pageerror",
        (error) =>
          void runtime.log({ type: "page_error", error: error.message }),
      );
      await page.setContent(html, { waitUntil: "load" });
      // Capture the referee before any other code can run, then remove its global.
      runtime.referee = await page.evaluateHandle((k) => {
        const api = (window as any)[k];
        delete (window as any)[k];
        if (!api) throw new Error("Referee unavailable");
        return api;
      }, key);
      await page.evaluate(() => document.fonts.ready);
      const rect = await page.locator("#game").boundingBox();
      if (!rect) throw new Error("Canvas unavailable");
      runtime.canvasRect = rect;
      if (runtime.artifacts) {
        await mkdir(runtime.artifacts, { recursive: true });
        await runtime.log({
          type: "session",
          schema_version: 3,
          clock: "realtime",
          record_video: options.recordVideo ?? false,
          upstream,
          viewport,
          browser_version: browser.version(),
          packaged_game_sha256: sha256(packagedGame(original)),
          refereed_template_sha256: sha256(html.replaceAll(key, "KEY")),
        });
        runtime.telemetryTimer = setInterval(() => void runtime.sample(), 100);
      }
      return runtime;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new Error("Game session is closed");
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async log(row: Record<string, unknown>): Promise<void> {
    if (this.artifacts)
      await appendFile(
        resolve(this.artifacts, "trace.jsonl"),
        JSON.stringify({
          host_ms: Math.round(performance.now() - this.epoch),
          ...row,
        }) + "\n",
      );
  }
  private persist(scene: Scene): Promise<void> {
    // Capture receipt before queued filesystem work; I/O latency is not clock drift.
    const sampledHostMs = performance.now() - this.epoch;
    const next = this.persistence.then(async () => {
      if (!this.artifacts) return;
      const path = resolve(this.artifacts, "state.json");
      await writeFile(path + ".tmp", JSON.stringify(scene, null, 2) + "\n");
      await rename(path + ".tmp", path);
      await appendFile(
        resolve(this.artifacts, "timeline.jsonl"),
        JSON.stringify({
          host_ms: sampledHostMs,
          persisted_host_ms: performance.now() - this.epoch,
          scene,
        }) + "\n",
      );
      if (scene.phase === "finished" && !this.finalSaved) {
        this.finalSaved = true;
        await writeFile(
          resolve(this.artifacts, "final.png"),
          await this.page.screenshot({ type: "png" }),
        );
      }
    });
    this.persistence = next.catch(() => {});
    return next;
  }
  private async sample(): Promise<void> {
    if (this.telemetryBusy || this.closed) return;
    this.telemetryBusy = true;
    try {
      await this.persist(await this.rawScene());
    } catch (error) {
      await this.log({ type: "telemetry_error", error: String(error) });
    } finally {
      this.telemetryBusy = false;
    }
  }
  /** Referee calls; errors reach interfaces as one-line codes, never referee source or stacks. */
  private async ref(
    fn: (r: any, arg: any) => unknown,
    arg?: unknown,
  ): Promise<any> {
    if (this.fatalAdapterError) throw this.fatalAdapterError;
    try {
      return await this.referee.evaluate(fn as any, arg);
    } catch (error) {
      const line = String(error instanceof Error ? error.message : error)
        .split("\n")[0]
        .replace(/^jsHandle\.evaluate:\s*/, "")
        .replace(/^Error:\s*/, "");
      throw new Error(line);
    }
  }
  private rawScene(): Promise<Scene> {
    return this.ref((r: any) => r.scene()) as Promise<Scene>;
  }
  scene(): Promise<Scene> {
    return this.serial(() => this.rawScene());
  }
  /** Read current state while a single bounded native path may still be executing. */
  peek(): Promise<Scene> {
    if (this.closed) return Promise.reject(new Error("Game session is closed"));
    return this.rawScene();
  }
  integrity(): Promise<Integrity> {
    return this.ref((r: any) => r.integrity()) as Promise<Integrity>;
  }
  actionStatus() {
    return {
      pending_action:
        this.activeAction === undefined
          ? null
          : { action_id: this.activeAction, status: "executing" as const },
      previous_action: this.previousAction,
    };
  }
  observe(input: Observe): Promise<ObservationResult> {
    return this.serial(async () => {
      if (
        !["immediate", "new_fruit"].includes(input.until) ||
        !Number.isInteger(input.timeout_ms) ||
        input.timeout_ms < 1 ||
        input.timeout_ms > 2500
      )
        throw new Error(
          "Observation timeout must be 1..2500 real milliseconds",
        );
      const result = (await this.ref(
        (r: any, input) => r.observe(input),
        input,
      )) as ObservationResult;
      await this.log({ type: "observation_wait", input, result });
      await this.persist(result.scene);
      return result;
    });
  }
  /** Prepare the one round, then harden the realm before any agent code can be loaded. */
  prepare(input: NewGame): Promise<Scene> {
    return this.serial(async () => {
      if (this.lockdown)
        throw new Error("A session permits one prepared round.");
      await this.page.evaluate(
        (input) => (window as any).__fnPrepare(input),
        input,
      );
      this.lockdown = (await this.page.evaluate(lockdownSource)) as Record<
        string,
        unknown
      >;
      const baseline = await this.ref((r: any) => r.baseline());
      const scene = await this.rawScene();
      this.arena = scene.arena;
      await this.log({
        type: "prepare",
        input,
        lockdown: this.lockdown,
        baseline,
        scene,
      });
      await this.persist(scene);
      return scene;
    });
  }
  /** Inject a frozen agent adapter into the hardened page. Returns its exported function names. */
  injectAdapter(source: string): Promise<string[]> {
    return this.serial(async () => {
      if (!this.lockdown)
        throw new Error("Prepare the round before loading an adapter");
      if (this.adapter) throw new Error("An adapter is already loaded");
      this.adapter = await this.page.evaluateHandle(adapterExpression(source));
      this.adapterExports = (await this.adapter.evaluate((exports: any) =>
        Object.keys(exports ?? {}).filter(
          (name) => typeof exports[name] === "function",
        ),
      )) as string[];
      await this.log({
        type: "adapter_loaded",
        sha256: sha256(source),
        exports: this.adapterExports,
      });
      return this.adapterExports;
    });
  }
  /** Call an exported adapter function. Runs concurrently with an executing path, like peek(). */
  async adapterCall(
    fn: string,
    args: unknown,
    timeoutMs = 2000,
  ): Promise<unknown> {
    if (this.fatalAdapterError) throw this.fatalAdapterError;
    if (this.closed) throw new Error("Game session is closed");
    if (!this.adapter) throw new Error("ADAPTER_MISSING: no adapter is loaded");
    if (!this.adapterExports.includes(fn))
      throw new Error(
        `ADAPTER_MISSING: ${fn} is not an exported adapter function`,
      );
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.adapter.evaluate(
          async (exports: any, [fn, args]) => await exports[fn as string](args),
          [fn, args] as const,
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `ADAPTER_TIMEOUT: ${fn} exceeded ${timeoutMs}ms`,
            );
            this.fatalAdapterError = error;
            // Browser.close uses the browser connection, so it can interrupt a renderer
            // blocked in synchronous adapter code. Further referee calls fail immediately.
            void this.browser.close({ reason: error.message }).catch(() => {});
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  start(): Promise<Scene> {
    return this.serial(async () => {
      const scene = (await this.ref((r: any) => r.start())) as Scene;
      await this.log({ type: "start", scene });
      await this.persist(scene);
      return scene;
    });
  }
  events(
    after = 0,
    limit = 100,
  ): Promise<{ events: GameEvent[]; last_seq: number }> {
    return this.serial(
      () =>
        this.ref((r: any, { after, limit }) => r.events(after, limit), {
          after,
          limit,
        }) as Promise<{ events: GameEvent[]; last_seq: number }>,
    );
  }
  async screenshot(concurrent = false): Promise<Buffer> {
    const capture = async () => {
      const before = await this.rawScene(),
        start = performance.now();
      const bytes = await this.page.screenshot({ type: "png" });
      this.lastCaptureAt = before.clock_audit.observed_at_ms;
      const frame = ++this.frame;
      if (this.artifacts) {
        await mkdir(resolve(this.artifacts, "frames"), { recursive: true });
        await writeFile(
          resolve(this.artifacts, "frames", `${frame}.png`),
          bytes,
        );
      }
      await this.log({
        type: "screenshot",
        frame,
        observed_at_ms: this.lastCaptureAt,
        capture_wall_ms: performance.now() - start,
      });
      return bytes;
    };
    if (concurrent) {
      if (this.closed) throw new Error("Game session is closed");
      return capture();
    }
    return this.serial(capture);
  }
  click(x: number, y: number): Promise<void> {
    return this.serial(async () => {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x > viewport.width ||
        y > viewport.height
      )
        throw new Error("Click outside viewport");
      const start = performance.now();
      await this.ref((r: any) => r.strokeBegin());
      try {
        await this.page.mouse.click(x, y);
      } finally {
        await this.ref((r: any) => r.strokeEnd());
      }
      await this.log({
        type: "click",
        x,
        y,
        actual_duration_ms: performance.now() - start,
      });
      await this.persist(await this.rawScene());
    });
  }
  swipe(input: Swipe): Promise<ActionResult> {
    return this.path(input, "canvas");
  }
  guiDrag(points: TimedPoint[]): Promise<ActionResult> {
    return this.path({ points, observed_at_ms: this.lastCaptureAt }, "screen");
  }
  /** Screen-space path for the generated-MCP game port: identical executor to GUI drag. */
  portPath(points: TimedPoint[]): Promise<ActionResult> {
    return this.path({ points }, "screen");
  }
  async submitPath(
    input: Swipe,
    space: "canvas" | "screen",
  ): Promise<SubmittedAction> {
    // Reserve the slot before yielding. A second request never queues a future stroke.
    if (this.activeAction !== undefined) {
      return {
        accepted: false,
        action_id: this.activeAction,
        scene: await this.peek(),
        ...this.actionStatus(),
      };
    }
    validatePath(input.points, space === "canvas" ? this.arena : viewport);
    const actionId = ++this.actionId;
    this.activeAction = actionId;
    let accept!: (scene: Scene) => void, reject!: (reason: unknown) => void;
    const accepted = new Promise<Scene>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    const job = this.path(
      {
        ...input,
        observed_at_ms:
          input.observed_at_ms ??
          (space === "screen" ? this.lastCaptureAt : undefined),
      },
      space,
      accept,
    );
    void job.then(
      (result) => {
        this.previousAction = {
          action_id: actionId,
          status: "completed",
          actual_duration_ms: result.actual_duration_ms,
          events: result.events,
        };
        this.activeAction = undefined;
      },
      (error) => {
        this.previousAction = {
          action_id: actionId,
          status: "failed",
          error: String(error),
        };
        this.activeAction = undefined;
        reject(error);
        void this.log({
          type: "path_failed",
          action_id: actionId,
          space,
          error: String(error),
        }).catch((error) => console.error(error));
      },
    );
    const scene = await accepted;
    return {
      accepted: true,
      action_id: actionId,
      scene,
      ...this.actionStatus(),
    };
  }
  private path(
    input: Swipe,
    space: "canvas" | "screen",
    onAccepted?: (scene: Scene) => void,
  ): Promise<ActionResult> {
    return this.serial(async () => {
      validatePath(input.points, space === "canvas" ? this.arena : viewport);
      let points = input.points;
      if (space === "canvas") {
        const rect = this.canvasRect;
        points = points.map((p) => ({
          ...p,
          x: rect.x + (p.x * rect.width) / this.arena.width,
          y: rect.y + (p.y * rect.height) / this.arena.height,
        }));
      }
      const accepted = (await this.ref(
        (r: any, expected) => r.markAction(expected),
        input.expected_revision,
      )) as { scene: Scene; last_seq: number };
      const before = accepted.scene;
      const started = performance.now(),
        observedAge =
          input.observed_at_ms === undefined
            ? null
            : Math.max(
                0,
                before.clock_audit.observed_at_ms - input.observed_at_ms,
              );
      await this.log({
        type: "path_started",
        space,
        input,
        observed_age_ms: observedAge,
      });
      onAccepted?.(before);
      let samples: PointerSample[] = [];
      let bladeStarted = performance.now();
      try {
        await this.page.mouse.move(points[0].x, points[0].y);
        await this.page.mouse.down();
        bladeStarted = performance.now();
        try {
          samples = await executeTimedPath(points, {
            move: (x, y) => this.page.mouse.move(x, y),
          });
        } finally {
          await this.page.mouse.up();
        }
      } finally {
        await this.ref((r: any) => r.strokeEnd());
      }
      // Log after mouse-up; timestamp fields retain real issuance/acknowledgement times.
      await this.log({
        type: "mouse_samples",
        host_ms: bladeStarted - this.epoch,
        samples,
      });
      const completed = (await this.ref(
        (r: any, after) => ({
          scene: r.scene(),
          events: r.events(after, 200).events,
        }),
        accepted.last_seq,
      )) as { scene: Scene; events: GameEvent[] };
      const scene = completed.scene;
      const result = {
        scene,
        actual_duration_ms: Math.round(performance.now() - started),
        observed_age_ms: observedAge,
        events: completed.events,
      };
      await this.log({ type: "path_finished", space, result });
      await this.persist(scene);
      return result;
    });
  }
  wait(input: Wait): Promise<ActionResult> {
    return this.serial(async () => {
      if (
        !Number.isInteger(input.duration_ms) ||
        input.duration_ms < 1 ||
        input.duration_ms > 3000
      )
        throw new Error("Wait must be 1..3000 real milliseconds");
      const before = await this.rawScene(),
        start = performance.now();
      await sleep(input.duration_ms);
      const scene = await this.rawScene(),
        events = (await this.ref(
          (r: any, after) => r.events(after, 200),
          0,
        )) as { events: GameEvent[] };
      const result = {
        scene,
        actual_duration_ms: Math.round(performance.now() - start),
        observed_age_ms: null,
        events: events.events.filter((e) => e.at_ms >= before.elapsed_ms),
      };
      await this.log({ type: "wait", input, result });
      await this.persist(scene);
      return result;
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    await this.queue;
    while (this.telemetryBusy) await sleep(10);
    await this.persistence;
    const video = this.page.video();
    try {
      await this.page.context().close();
      if (video && this.artifacts)
        await rename(await video.path(), resolve(this.artifacts, "game.webm"));
    } catch (error) {
      if (!this.fatalAdapterError) throw error;
    }
    await this.browser.close();
  }
}
