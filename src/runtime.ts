import { chromium, type Browser, type Page } from "playwright-core";
import { access, appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { instrumentGame, loadGame, upstream } from "./upstream.js";
import { executeTimedPath, type PointerSample } from "./pointer.js";
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

export const viewport = { width: 1440, height: 960 };
export interface RuntimeOptions {
  browser?: string;
  artifacts?: string;
  headless?: boolean;
  recordVideo?: boolean;
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

/** Same validation and native mouse executor are used for BOTH interfaces. */
export function validatePath(
  points: TimedPoint[],
  bounds: { width: number; height: number },
): void {
  if (!Array.isArray(points) || points.length < 2 || points.length > 32)
    throw new Error("A drag needs 2..32 timed points");
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      previous = points[i - 1];
    if (
      ![p.x, p.y, p.t_ms].every(Number.isFinite) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x > bounds.width ||
      p.y > bounds.height ||
      !Number.isInteger(p.t_ms) ||
      (i === 0 ? p.t_ms !== 0 : p.t_ms <= previous.t_ms)
    )
      throw new Error(
        "Coordinates must be inside bounds; integer t_ms starts at 0 and strictly increases",
      );
    if (
      previous &&
      Math.hypot(p.x - previous.x, p.y - previous.y) /
        ((p.t_ms - previous.t_ms) / 1000) >
        5000
    )
      throw new Error("Blade speed exceeds 5000 px/s");
  }
  const duration = points.at(-1)!.t_ms;
  if (duration < 16 || duration > 1000)
    throw new Error("A drag must last 16..1000 milliseconds");
}

export class GameRuntime {
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
  private readonly epoch = performance.now();
  private constructor(
    readonly browser: Browser,
    readonly page: Page,
    readonly artifacts?: string,
  ) {}

  static async launch(options: RuntimeOptions = {}): Promise<GameRuntime> {
    if (options.recordVideo && !options.artifacts)
      throw new Error("Video recording requires an artifacts directory");
    const html = instrumentGame(await loadGame());
    const browser = await chromium.launch({
      executablePath: await browserExecutable(options.browser),
      headless: options.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
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
      await page.waitForFunction("!!window.fruitNinjaMcp");
      await page.evaluate(() => document.fonts.ready);
      const rect = await page.locator("#game").boundingBox();
      if (!rect) throw new Error("Canvas unavailable");
      runtime.canvasRect = rect;
      if (runtime.artifacts) {
        await mkdir(runtime.artifacts, { recursive: true });
        await runtime.log({
          type: "session",
          schema_version: 2,
          clock: "realtime",
          record_video: options.recordVideo ?? false,
          upstream,
          viewport,
          browser_version: browser.version(),
          instrumented_game_sha256: createHash("sha256")
            .update(html)
            .digest("hex"),
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
  private async log(row: Record<string, unknown>): Promise<void> {
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
    const next = this.persistence.then(async () => {
      if (!this.artifacts) return;
      const path = resolve(this.artifacts, "state.json");
      await writeFile(path + ".tmp", JSON.stringify(scene, null, 2) + "\n");
      await rename(path + ".tmp", path);
      await appendFile(
        resolve(this.artifacts, "timeline.jsonl"),
        JSON.stringify({ host_ms: performance.now() - this.epoch, scene }) +
          "\n",
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
  private rawScene(): Promise<Scene> {
    return this.page.evaluate("window.fruitNinjaMcp.scene()") as Promise<Scene>;
  }
  scene(): Promise<Scene> {
    return this.serial(() => this.rawScene());
  }
  /** Read current state while a single bounded native path may still be executing. */
  peek(): Promise<Scene> {
    if (this.closed) return Promise.reject(new Error("Game session is closed"));
    return this.rawScene();
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
      const result = (await this.page.evaluate(
        (input) => (window as any).fruitNinjaMcp.observe(input),
        input,
      )) as ObservationResult;
      await this.log({ type: "observation_wait", input, result });
      await this.persist(result.scene);
      return result;
    });
  }
  prepare(input: NewGame): Promise<Scene> {
    return this.serial(async () => {
      const scene = (await this.page.evaluate(
        (input) => (window as any).fruitNinjaMcp.prepare(input),
        input,
      )) as Scene;
      this.arena = scene.arena;
      await this.log({ type: "prepare", input, scene });
      await this.persist(scene);
      return scene;
    });
  }
  start(): Promise<Scene> {
    return this.serial(async () => {
      const scene = (await this.page.evaluate(
        "window.fruitNinjaMcp.start()",
      )) as Scene;
      await this.log({ type: "start", scene });
      await this.persist(scene);
      return scene;
    });
  }
  events(
    after = 0,
    limit = 100,
  ): Promise<{ events: GameEvent[]; last_seq: number }> {
    return this.serial(() =>
      this.page.evaluate(
        ({ after, limit }) =>
          (window as any).fruitNinjaMcp.events(after, limit),
        { after, limit },
      ),
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
      await this.page.mouse.click(x, y);
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
      const accepted = (await this.page.evaluate(
        (expected) => (window as any).fruitNinjaMcp.markAction(expected),
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
      await this.page.mouse.move(points[0].x, points[0].y);
      await this.page.mouse.down();
      const bladeStarted = performance.now();
      let samples: PointerSample[] = [];
      try {
        samples = await executeTimedPath(points, {
          move: (x, y) => this.page.mouse.move(x, y),
        });
      } finally {
        await this.page.mouse.up();
      }
      // Log after mouse-up; timestamp fields retain real issuance/acknowledgement times.
      await this.log({
        type: "mouse_samples",
        host_ms: bladeStarted - this.epoch,
        samples,
      });
      const completed = (await this.page.evaluate((after) => {
        const b = (window as any).fruitNinjaMcp;
        return { scene: b.scene(), events: b.events(after, 200).events };
      }, accepted.last_seq)) as { scene: Scene; events: GameEvent[] };
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
        events = (await this.page.evaluate(
          (after) => (window as any).fruitNinjaMcp.events(after, 200),
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
    await this.page.context().close();
    if (video && this.artifacts)
      await rename(await video.path(), resolve(this.artifacts, "game.webm"));
    await this.browser.close();
  }
}
