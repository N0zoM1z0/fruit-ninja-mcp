import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { connectDesktop } from "./desktop.mjs";

export const GAME_SHA256 =
  "1c40a38a42bd21ce7cc7e769a056c4338c44df9ef257c8efebd01144a4ebce3d";
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUpTo(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function wineEnvironment({ display, prefix, evidenceDir }) {
  return {
    ...process.env,
    // MCP clients often pass a reduced environment. Wine uses the user's
    // runtime directory to discover PulseAudio and Vulkan services.
    XDG_RUNTIME_DIR:
      process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
    DISPLAY: display,
    WINEPREFIX: prefix,
    WINEARCH: "win32",
    WINEDEBUG: "-all",
    WINEDLLOVERRIDES: "d3d9=n",
    DXVK_LOG_PATH: evidenceDir,
    DXVK_FRAME_RATE: process.env.FN_GAME_FPS ?? "30",
    DXVK_CONFIG:
      process.env.DXVK_CONFIG ??
      "d3d9.presentInterval = 0; dxvk.numCompilerThreads = 2",
    // Lavapipe's many default worker stacks exhaust a 32-bit game's address
    // space while allocating result-screen textures. Keep the driver bounded.
    LP_NUM_THREADS: process.env.LP_NUM_THREADS ?? "4",
  };
}

function childExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function stopChild(child, graceMs = 3000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exit = childExit(child);
  child.kill("SIGTERM");
  if (await waitUpTo(exit, graceMs)) return;
  child.kill("SIGKILL");
  await exit;
}

async function spawnLogged(command, args, { logPath, ...options }) {
  const log = await open(logPath, "a");
  try {
    const child = spawn(command, args, {
      ...options,
      stdio: options.stdio ?? ["ignore", log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  } finally {
    await log.close();
  }
}

async function runLogged(command, args, options, timeoutMs) {
  const child = await spawnLogged(command, args, options);
  const exit = childExit(child);
  const result = await waitUpTo(exit, timeoutMs);
  if (!result) {
    await stopChild(child);
    throw new Error(
      `${command} timed out after ${timeoutMs} ms; see ${options.logPath}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `${command} exited ${result.code ?? result.signal}; see ${options.logPath}`,
    );
  }
}

/**
 * Connect to the Win32 helper using a private Wine subprocess.
 * Requests are serialized; replies are the helper's parsed JSON (including ok:false).
 * close() closes this helper only, releasing any mouse button it owns.
 */
export async function connectHelper({
  display,
  prefix,
  helperPath,
  commandTimeoutMs = 10000,
  logPath = path.join(path.dirname(prefix), "evidence", "helper.log"),
}) {
  if (!display || !path.isAbsolute(prefix) || !path.isAbsolute(helperPath)) {
    throw new Error(
      "connectHelper requires display and absolute prefix/helperPath",
    );
  }
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error("commandTimeoutMs must be positive");
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, "a");
  let child;
  try {
    child = spawn("wine", [helperPath], {
      env: wineEnvironment({
        display,
        prefix,
        evidenceDir: path.dirname(logPath),
      }),
      stdio: ["pipe", "pipe", log.fd],
    });
  } catch (error) {
    await log.close();
    throw error;
  }
  const lines = createInterface({ input: child.stdout });
  let failure = null;
  let waiter = null;
  let closing = false;
  let closePromise;
  let queue = Promise.resolve();
  const exit = childExit(child);

  function fail(error) {
    failure ??= error;
    if (waiter) {
      clearTimeout(waiter.timer);
      const pending = waiter;
      waiter = null;
      pending.reject(failure);
    }
  }
  child.once("error", (error) => fail(error));
  child.once("close", (code, signal) => {
    fail(new Error(`Win32 helper exited ${code ?? signal}; see ${logPath}`));
    lines.close();
  });
  child.stdin.on("error", (error) => fail(error));
  lines.on("line", (line) => {
    if (!waiter) {
      fail(new Error(`Unexpected Win32 helper output: ${line.slice(0, 160)}`));
      child.stdin.end();
      return;
    }
    let reply;
    try {
      reply = JSON.parse(line);
      if (
        !reply ||
        typeof reply !== "object" ||
        typeof reply.ok !== "boolean"
      ) {
        throw new Error("reply lacks boolean ok");
      }
    } catch (error) {
      fail(new Error(`Invalid Win32 helper JSON: ${error.message}`));
      child.stdin.end();
      return;
    }
    clearTimeout(waiter.timer);
    const pending = waiter;
    waiter = null;
    pending.resolve(reply);
  });

  function perform(line) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(
          new Error(`Win32 helper command timed out: ${line.split(" ")[0]}`),
        );
        // EOF lets the helper release its own held mouse button.
        child.stdin.end();
      }, commandTimeoutMs);
      waiter = { resolve, reject, timer };
      child.stdin.write(`${line}\n`, (error) => {
        if (error) fail(error);
      });
    });
  }

  function enqueue(line) {
    const result = queue.then(() => perform(line));
    queue = result.catch(() => {});
    return result;
  }

  function request(line) {
    if (closing) return Promise.reject(new Error("Win32 helper is closing"));
    if (
      typeof line !== "string" ||
      !line.trim() ||
      /[\r\n\0]/.test(line) ||
      Buffer.byteLength(line, "utf8") > 1022
    ) {
      return Promise.reject(
        new Error("Expected one helper command of at most 1022 bytes"),
      );
    }
    return enqueue(line);
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try {
        await queue;
        if (!failure) await enqueue("close");
      } finally {
        child.stdin.end();
        const ended = await waitUpTo(exit, 2000);
        if (!ended) await stopChild(child, 1000);
        lines.close();
      }
    })();
    return closePromise;
  }

  await log.close();
  try {
    await request("info");
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return { request, close, nativeSnapshot: true };
}

async function prepareHelper(root, helperPath, evidenceDir) {
  const source = path.join(root, "native", "win32-helper.c");
  const sourceInfo = await stat(source);
  const binaryInfo = await stat(helperPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (binaryInfo && binaryInfo.mtimeMs >= sourceInfo.mtimeMs) return;
  await mkdir(path.dirname(helperPath), { recursive: true });
  await runLogged(
    "i686-w64-mingw32-gcc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      source,
      "-o",
      helperPath,
    ],
    { cwd: root, logPath: path.join(evidenceDir, "build-helper.log") },
    60000,
  );
}

async function startDisplay(evidenceDir) {
  const size = process.env.FN_DISPLAY_SIZE ?? "1024x768";
  if (!["800x600", "1024x768"].includes(size))
    throw new Error("FN_DISPLAY_SIZE must be 800x600 or 1024x768");
  const log = await open(path.join(evidenceDir, "xvfb.log"), "a");
  let child;
  try {
    child = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", `${size}x24`, "-nolisten", "tcp"],
      { stdio: ["ignore", log.fd, log.fd, "pipe"] },
    );
    const display = await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdio[3] });
      const timer = setTimeout(
        () => finish(new Error("Xvfb display allocation timed out")),
        10000,
      );
      function finish(error, value) {
        clearTimeout(timer);
        lines.close();
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        if (error) reject(error);
        else resolve(value);
      }
      function onError(error) {
        finish(error);
      }
      function onExit(code, signal) {
        finish(new Error(`Xvfb exited ${code ?? signal}`));
      }
      child.once("error", onError);
      child.once("exit", onExit);
      lines.once("line", (line) => {
        if (!/^\d+$/.test(line.trim()))
          finish(new Error("Invalid Xvfb display number"));
        else finish(null, `:${line.trim()}`);
      });
    });
    child.on("error", () => {});
    return { child, display };
  } catch (error) {
    await stopChild(child);
    throw error;
  } finally {
    await log.close();
  }
}

async function waitForGame(helper, game, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let attached = false;
  let latest;
  while (Date.now() < deadline) {
    if (game && (game.exitCode !== null || game.signalCode !== null)) {
      throw new Error(
        `FruitNinja.exe exited ${game.exitCode ?? game.signalCode}; see game.log`,
      );
    }
    latest = await helper.request(attached ? "info" : "attach FruitNinja.exe");
    if (latest.ok && latest.alive) {
      attached = true;
      if (latest.window?.width > 500 && latest.window?.height > 500)
        return latest;
    } else if (!latest.ok && latest.error !== "target-not-found") {
      throw new Error(`Unable to attach FruitNinja.exe: ${latest.error}`);
    } else if (attached && !latest.alive) {
      throw new Error("FruitNinja.exe exited before its window became ready");
    }
    await sleep(200);
  }
  throw new Error(
    `FruitNinja.exe window was not ready after ${timeoutMs} ms; last reply ${JSON.stringify(latest)}`,
  );
}

/**
 * Launch a pinned Windows game in Wine, owning only the processes started here.
 * attach:true requires an explicit display and never launches/stops the game/Xvfb.
 * gamePid is the owned Linux child PID (null in attach mode); targetPid is Win32.
 */
export async function launchGame({
  root = DEFAULT_ROOT,
  display,
  attach = false,
  prefix,
  helperPath,
  startupTimeoutMs = 90000,
} = {}) {
  root = path.resolve(root);
  prefix = path.resolve(prefix ?? path.join(root, ".local", "windows", "wine"));
  helperPath = path.resolve(
    helperPath ??
      path.join(root, ".local", "windows", "toolchain", "win32-helper.exe"),
  );
  if (attach && !display)
    throw new Error("attach:true requires the existing game DISPLAY");
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new Error("startupTimeoutMs must be positive");
  }
  const gameDir = path.join(root, ".local", "windows", "game");
  const evidenceDir = path.join(root, ".local", "windows", "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const exePath = path.join(gameDir, "FruitNinja.exe");
  const digest = createHash("sha256")
    .update(await readFile(exePath))
    .digest("hex");
  if (digest !== GAME_SHA256) {
    throw new Error(
      `FruitNinja.exe SHA-256 mismatch: expected ${GAME_SHA256}, got ${digest}`,
    );
  }
  await prepareHelper(root, helperPath, evidenceDir);

  let displayChild;
  let game;
  let gameEnv;
  let helper;
  let desktop;
  let closePromise;
  function close() {
    closePromise ??= (async () => {
      let cleanupError;
      try {
        await desktop?.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await helper?.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await stopChild(game);
      } catch (error) {
        cleanupError ??= error;
      }
      // This prefix belongs to this project. Once its owned game has stopped,
      // stop its Wine services before closing Xvfb so the next run can use a
      // different display. An attach or rejected pre-existing game is preserved.
      if (game && gameEnv) {
        try {
          await runLogged(
            "wineserver",
            ["-k"],
            {
              env: gameEnv,
              logPath: path.join(evidenceDir, "wine-cleanup.log"),
            },
            5000,
          );
          await runLogged(
            "wineserver",
            ["-w"],
            {
              env: gameEnv,
              logPath: path.join(evidenceDir, "wine-cleanup.log"),
            },
            5000,
          );
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        await stopChild(displayChild);
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) throw cleanupError;
    })();
    return closePromise;
  }

  try {
    if (!attach) {
      await access(path.join(gameDir, "d3d9.dll")).catch(() => {
        throw new Error(
          "DXVK d3d9.dll is missing; run the Windows setup first",
        );
      });
      if (!display) {
        const started = await startDisplay(evidenceDir);
        displayChild = started.child;
        display = started.display;
      }
      gameEnv = wineEnvironment({ display, prefix, evidenceDir });
      try {
        await access(path.join(prefix, "system.reg"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await mkdir(prefix, { recursive: true });
        await runLogged(
          "wineboot",
          ["-u"],
          {
            cwd: root,
            env: gameEnv,
            logPath: path.join(evidenceDir, "wineboot.log"),
          },
          60000,
        );
      }
    } else await access(path.join(prefix, "system.reg"));

    helper = await connectHelper({
      display,
      prefix,
      helperPath,
      commandTimeoutMs: Math.min(startupTimeoutMs, 10000),
      logPath: path.join(evidenceDir, "helper.log"),
    });
    if (!attach) {
      const existing = await helper.request("attach FruitNinja.exe");
      if (existing.ok || existing.error !== "target-not-found") {
        throw new Error(
          "FruitNinja.exe already runs in this Wine prefix; use attach:true with its display",
        );
      }
      game = await spawnLogged("wine", ["FruitNinja.exe"], {
        cwd: gameDir,
        env: gameEnv,
        logPath: path.join(evidenceDir, "game.log"),
      });
    }
    const info = await waitForGame(helper, game, startupTimeoutMs);
    // Xvfb has no window manager: Win32 foreground state alone does not focus X11.
    await runLogged(
      "xdotool",
      [
        "search",
        "--onlyvisible",
        "--name",
        "^Fruit Ninja$",
        "windowfocus",
        "--sync",
      ],
      {
        env: { ...process.env, DISPLAY: display },
        logPath: path.join(evidenceDir, "focus.log"),
      },
      5000,
    );
    desktop = await connectDesktop({
      display,
      logPath: path.join(evidenceDir, "desktop.log"),
    });
    return {
      helper,
      desktop,
      display,
      prefix,
      gamePid: game?.pid ?? null,
      targetPid: info.pid,
      close,
    };
  } catch (error) {
    await close().catch((cleanupError) => {
      error.message += `; cleanup: ${cleanupError.message}`;
    });
    throw error;
  }
}
