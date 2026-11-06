// PUBLIC: run the packaged game with the same hardening, adapter loading and native input
// executor as play time, but WITHOUT any referee. Used by builders (fn-port) and by smoke.
import {
  chromium,
  type Browser,
  type JSHandle,
  type Page,
} from "playwright-core";
import {
  executeTimedPath,
  pathLimits,
  validatePath,
  type TimedPoint,
} from "./executor.js";
import { adapterExpression, lockdownSource } from "./lockdown.js";
import { PortError, portLimits, type PortBackend } from "./port.js";

export const viewport = { width: 1440, height: 960 };
export interface DevGameOptions {
  html: string;
  executablePath: string;
  headless?: boolean;
  mode?: "arcade" | "classic" | "zen";
  seed?: number;
  duration_seconds?: number;
  adapterSource?: string;
  /** "standard": a path request returns after execution; "async": returns at acceptance. */
  profile?: "standard" | "async";
}

export class DevGame implements PortBackend {
  private adapter?: JSHandle;
  exports: string[] = [];
  lockdown: Record<string, unknown> = {};
  private actionId = 0;
  private active?: number;
  private previous: Record<string, unknown> | null = null;
  private constructor(
    readonly browser: Browser,
    readonly page: Page,
    readonly profile: "standard" | "async",
  ) {}
  static async launch(options: DevGameOptions): Promise<DevGame> {
    const browser = await chromium.launch({
      executablePath: options.executablePath,
      headless: options.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    try {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
      });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(options.html, { waitUntil: "load" });
      const game = new DevGame(browser, page, options.profile ?? "standard");
      await page.evaluate((config) => (window as any).__fnPrepare(config), {
        mode: options.mode ?? "arcade",
        seed: options.seed ?? 1,
        ...(options.mode === "classic"
          ? {}
          : { duration_seconds: options.duration_seconds ?? 60 }),
      });
      game.lockdown = (await page.evaluate(lockdownSource)) as Record<
        string,
        unknown
      >;
      if (options.adapterSource !== undefined) {
        game.adapter = await page.evaluateHandle(
          adapterExpression(options.adapterSource),
        );
        game.exports = (await game.adapter.evaluate((exports: any) =>
          Object.keys(exports ?? {}).filter(
            (name) => typeof exports[name] === "function",
          ),
        )) as string[];
      }
      return game;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  info() {
    return {
      viewport,
      coordinates:
        "Page CSS pixels of the 1440x960 viewport, origin top-left (same as GUI screenshots).",
      limits: pathLimits,
      profile: this.profile,
      adapter: { loaded: !!this.adapter, exports: this.exports },
      input_policy:
        "Native mouse only. One path executes at a time; busy requests are rejected, never queued.",
    };
  }
  async adapterCall(fn: string, args: unknown): Promise<unknown> {
    if (!this.adapter)
      throw new PortError("ADAPTER_MISSING", "no adapter is loaded", 404);
    if (!this.exports.includes(fn))
      throw new PortError("ADAPTER_MISSING", `${fn} is not exported`, 404);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.adapter.evaluate(
          async (exports: any, [fn, args]) => await exports[fn as string](args),
          [fn, args] as const,
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new PortError(
                  "ADAPTER_TIMEOUT",
                  `${fn} exceeded ${portLimits.adapter_timeout_ms}ms`,
                  504,
                ),
              ),
            portLimits.adapter_timeout_ms,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof PortError) throw error;
      throw new PortError(
        "ADAPTER_ERROR",
        String(error instanceof Error ? error.message : error).slice(0, 1000),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  status() {
    return {
      pending_action:
        this.active === undefined
          ? null
          : { action_id: this.active, status: "executing" },
      previous_action: this.previous,
    };
  }
  async click(x: number, y: number) {
    if (this.active !== undefined)
      throw new PortError("BUSY", "a path is executing", 409);
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height)
      throw new PortError("INVALID_CLICK", "outside viewport");
    await this.page.mouse.click(x, y);
    return { accepted: true };
  }
  async path(points: TimedPoint[], wait: boolean) {
    if (this.active !== undefined)
      throw new PortError(
        "BUSY",
        "a path is executing; nothing was queued",
        409,
      );
    try {
      validatePath(points, viewport);
    } catch (error) {
      throw new PortError("INVALID_PATH", (error as Error).message);
    }
    const id = ++this.actionId;
    this.active = id;
    const started = performance.now();
    const job = (async () => {
      try {
        await this.page.mouse.move(points[0].x, points[0].y);
        await this.page.mouse.down();
        try {
          await executeTimedPath(points, {
            move: (x, y) => this.page.mouse.move(x, y),
          });
        } finally {
          await this.page.mouse.up();
        }
        this.previous = {
          action_id: id,
          status: "completed",
          actual_duration_ms: Math.round(performance.now() - started),
        };
      } catch (error) {
        this.previous = {
          action_id: id,
          status: "failed",
          error: String(error),
        };
      } finally {
        this.active = undefined;
      }
    })();
    // Standard profile always blocks until mouse-up; async may return at acceptance.
    if (this.profile === "standard" || wait) await job;
    else void job;
    return { accepted: true, action_id: id, ...this.status() };
  }
  async close() {
    await this.browser.close();
  }
}
