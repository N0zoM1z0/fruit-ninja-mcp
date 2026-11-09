import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export async function connectDesktop({ display, logPath }) {
  const log = await open(logPath, "a");
  const child = spawn(
    "python3",
    [fileURLToPath(new URL("./desktop.py", import.meta.url)), display],
    { stdio: ["pipe", "pipe", log.fd] },
  );
  await log.close();
  const lines = createInterface({ input: child.stdout });
  let pending,
    failure,
    queue = Promise.resolve(),
    closed = false,
    closePromise;
  function fail(error) {
    failure ??= error;
    pending?.reject(error);
    pending = undefined;
  }
  child.on("error", fail);
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => {
      fail(new Error(`Desktop worker exited ${code ?? signal}`));
      resolve();
    }),
  );
  lines.on("line", (line) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    try {
      const result = JSON.parse(line);
      result.ok
        ? current.resolve(result)
        : current.reject(new Error(result.error));
    } catch (error) {
      current.reject(error);
    }
  });
  function send(args) {
    const operation = queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (failure) return reject(failure);
          const timer = setTimeout(() => {
            fail(new Error("Desktop worker timed out"));
            child.kill();
          }, 15000);
          pending = {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          };
          child.stdin.write(JSON.stringify(args) + "\n", (error) => {
            if (error) fail(error);
          });
        }),
    );
    queue = operation.catch(() => {});
    return operation;
  }
  const request = (args) =>
    closed
      ? Promise.reject(new Error("Desktop worker is closing"))
      : send(args);
  async function close() {
    closePromise ??= (async () => {
      closed = true;
      try {
        await queue;
        if (!failure) await send({ op: "close" });
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(timer);
        lines.close();
      }
    })();
    return closePromise;
  }
  try {
    await request({ op: "info" });
  } catch (error) {
    await close();
    throw error;
  }
  return { request, close };
}
