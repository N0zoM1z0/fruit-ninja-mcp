import { chromium, type Browser, type Page } from "playwright-core";
import { access, appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { instrumentGame, loadGame, upstream } from "./upstream.js";
import type {
  ActionResult,
  GameEvent,
  NewGame,
  Scene,
  Swipe,
  Wait,
} from "./types.js";

export interface RuntimeOptions {
  browser?: string;
  artifacts?: string;
  headless?: boolean;
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
  throw new Error(
    "Chromium was not found. Set FRUIT_NINJA_CHROMIUM to its executable path.",
  );
}

export class GameRuntime {
  private queue: Promise<unknown> = Promise.resolve();
  private errors: string[] = [];
  private closed = false;

  private constructor(
    readonly browser: Browser,
    readonly page: Page,
    readonly artifacts?: string,
  ) {
    page.on("pageerror", (error) => this.errors.push(error.message));
  }

  static async launch(options: RuntimeOptions = {}): Promise<GameRuntime> {
    const html = instrumentGame(await loadGame());
    const browser = await chromium.launch({
      executablePath: await browserExecutable(options.browser),
      headless: options.headless ?? true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        deviceScaleFactor: 1,
      });
      // The game is self-contained. A run must not depend on any external page or service.
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      const runtime = new GameRuntime(
        browser,
        page,
        options.artifacts && resolve(options.artifacts),
      );
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForFunction("!!window.fruitNinjaMcp");
      await page.evaluate(() => document.fonts.ready);
      if (runtime.errors.length) throw new Error(runtime.errors.join("\n"));
      if (runtime.artifacts) {
        await mkdir(runtime.artifacts, { recursive: true });
        await runtime.log({
          type: "session",
          schema_version: 1,
          upstream,
          browser_version: browser.version(),
          instrumented_game_sha256: createHash("sha256")
            .update(html)
            .digest("hex"),
          viewport: { width: 1440, height: 960 },
          clock: "decision",
        });
      }
      return runtime;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error("Game session is closed");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async log(record: Record<string, unknown>): Promise<void> {
    if (this.artifacts)
      await appendFile(
        resolve(this.artifacts, "trace.jsonl"),
        JSON.stringify(record) + "\n",
      );
  }

  private mutate<T extends Scene | ActionResult>(
    method: "newGame" | "swipe" | "wait",
    input: NewGame | Swipe | Wait,
  ): Promise<T> {
    return this.serial(async () => {
      const started = performance.now(),
        priorErrors = this.errors.length;
      try {
        const result = (await this.page.evaluate(
          ({ method, input }) => {
            const bridge = (
              window as unknown as {
                fruitNinjaMcp: Record<string, (value: unknown) => unknown>;
              }
            ).fruitNinjaMcp;
            return bridge[method](input);
          },
          { method, input },
        )) as T;
        if (this.errors.length > priorErrors)
          throw new Error(this.errors.slice(priorErrors).join("\n"));
        const scene = ("scene" in result ? result.scene : result) as Scene;
        await this.log({
          type: "action",
          method,
          input,
          result,
          scene_sha256: sceneHash(scene),
          wall_ms: Math.round(performance.now() - started),
        });
        if (this.artifacts) {
          const target = resolve(this.artifacts, "state.json");
          await writeFile(
            target + ".tmp",
            JSON.stringify(scene, null, 2) + "\n",
          );
          await rename(target + ".tmp", target);
          if (scene.phase === "finished")
            await writeFile(
              resolve(this.artifacts, "final.png"),
              await this.page.screenshot({
                type: "png",
                animations: "disabled",
              }),
            );
        }
        return result;
      } catch (error) {
        await this.log({
          type: "rejected_action",
          method,
          input,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  newGame(input: NewGame): Promise<Scene> {
    return this.mutate("newGame", input);
  }
  swipe(input: Swipe): Promise<ActionResult> {
    return this.mutate("swipe", input);
  }
  wait(input: Wait): Promise<ActionResult> {
    return this.mutate("wait", input);
  }

  scene(): Promise<Scene> {
    return this.serial(
      () =>
        this.page.evaluate("window.fruitNinjaMcp.scene()") as Promise<Scene>,
    );
  }

  events(
    after = 0,
    limit = 100,
  ): Promise<{ events: GameEvent[]; last_seq: number }> {
    return this.serial(() =>
      this.page.evaluate(
        ({ after, limit }) => {
          const bridge = (
            window as unknown as {
              fruitNinjaMcp: {
                events: (
                  after: number,
                  limit: number,
                ) => { events: GameEvent[]; last_seq: number };
              };
            }
          ).fruitNinjaMcp;
          return bridge.events(after, limit);
        },
        { after, limit },
      ),
    );
  }

  screenshot(): Promise<Buffer> {
    return this.serial(() =>
      this.page.screenshot({ type: "png", animations: "disabled" }),
    );
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    await this.browser.close();
  }
}
