import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const upstream = {
  repository: "https://github.com/yongqixue99-hue/fruit-ninja-dojo",
  revision: "63d0af1906181cceb9486ed85cc2b65ce6e6ba0d",
  sha256: "6e072f6efc0f2bb69c98dede80ed524deda20f0004d27b7beb2e80f5c4ddf96f",
  file: "index.html",
  license: null as string | null,
};
export const gamePath = resolve(root, ".local/game/index.html");
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function verifyGame(bytes: Buffer): void {
  if (sha256(bytes) !== upstream.sha256)
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

/**
 * Content-Security-Policy of the evaluation build. No network, no eval/new Function:
 * agent-authored adapters therefore cannot become generic in-page code executors.
 * Host CDP evaluation (lockdown, adapter injection, referee) is not subject to CSP.
 */
export const contentSecurityPolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/**
 * PUBLIC evaluation rules. This block is part of the packaged game that builders may
 * inspect and that both play modes run. It contains no referee state or APIs.
 */
const rulesSource = String.raw`
  // ===== Evaluation rules (public): realtime clock, seeded spawns, trusted input only =====
  // Capture native operations before adapters run. Event instances can have shadowing
  // own properties even when their prototypes are frozen. Only these private snapshots
  // reach collision detection; native getters brand-check every coalesced sample.
  const reefPointerGetters = Object.fromEntries([
    [MouseEvent.prototype, ['clientX', 'clientY', 'button']],
    [PointerEvent.prototype, ['pointerId']],
    [Event.prototype, ['timeStamp', 'type']],
  ].flatMap(([prototype, names]) => names.map(name =>
    [name, Object.getOwnPropertyDescriptor(prototype, name).get])));
  const reefCoalesced = PointerEvent.prototype.getCoalescedEvents;
  const reefPreventDefault = Event.prototype.preventDefault;
  const reefCanvasRect = Element.prototype.getBoundingClientRect.bind(canvas);
  const reefApply = Reflect.apply;
  function reefReadPointer(event) {
    if (event.isTrusted !== true) return null; // isTrusted is unforgeable on native events.
    const sample = {isTrusted: true};
    try {
      for (const [name, get] of Object.entries(reefPointerGetters)) sample[name] = reefApply(get, event, []);
    } catch { return null; }
    return sample;
  }
  var reefTick = 0, reefRound = 0, reefEntityId = 0, reefLocked = false, reefFinished = false;
  var reefConfig = {mode: 'arcade', seed: 42, duration_seconds: 60};
  var reefStartedAt = null, reefFinishedWall = null, reefLastPump = 0, reefMaxGap = 0, reefPumping = false;
  const reefNow = performance.now.bind(performance);
  let reefSpawnRandom = seeded(1);
  const reefSpawnRand = (a, b) => a + reefSpawnRandom() * (b - a);
  function reefFinishIfNeeded() {
    if (['ending','result'].includes(phase) && !reefFinished) {
      reefFinished = true;
      reefFinishedWall = reefNow() - reefStartedAt;
      reefOnFinish();
      if (phase === 'ending') { endDelay = 0; showResults(); }
    }
  }
  // Time is driven only by the monotonic wall clock; no caller can pause or advance it.
  function reefPump(now) {
    now = Math.max(Number.isFinite(now) ? now : 0, reefNow());
    if (reefStartedAt === null || phase !== 'playing' || reefPumping) return;
    reefPumping = true;
    try {
      reefMaxGap = Math.max(reefMaxGap, now - reefLastPump);
      reefLastPump = now;
      const targetTick = Math.floor((now - reefStartedAt) / (FIXED_STEP * 1000));
      while (reefTick < targetTick && phase === 'playing') {
        reefTick++;
        update(FIXED_STEP);
        reefAfterTick();
        reefFinishIfNeeded();
      }
      renderAlpha = 1;
    } finally { reefPumping = false; }
  }
  function reefPrepare(options) {
    if (reefRound || reefLocked) throw new Error('A session permits one prepared round.');
    options = options || {};
    if (!['classic','arcade','zen'].includes(options.mode)) throw new Error('Invalid game mode');
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 4294967295)
      throw new Error('Seed must be an unsigned 32-bit integer');
    if (options.duration_seconds !== undefined &&
        (!Number.isInteger(options.duration_seconds) || options.duration_seconds < 5 || options.duration_seconds > 90 || options.mode === 'classic'))
      throw new Error('Custom durations are 5..90 whole seconds in arcade or zen mode');
    reefConfig = {mode: options.mode, seed: options.seed, duration_seconds: options.duration_seconds};
    selectMode(options.mode);
    modes.arcade.seconds = options.mode === 'arcade' ? (options.duration_seconds ?? 60) : 60;
    modes.zen.seconds = options.mode === 'zen' ? (options.duration_seconds ?? 90) : 90;
    prefs.motion = false; soundOn = false; setSound();
    $('pause-button').disabled = true;
    $('fullscreen-button').disabled = true;
    reefLocked = true;
    return {mode: reefConfig.mode, duration_seconds: modes[reefConfig.mode].seconds};
  }
  function reefStartPreparedGame(event) {
    // Only a native (trusted) click may start a round; scripts cannot.
    if (event && event.isTrusted !== true) return false;
    if (reefRound) return false;
    if (!reefLocked) reefPrepare({mode: 'arcade', seed: (Math.random() * 4294967296) >>> 0});
    selectMode(reefConfig.mode);
    reefSpawnRandom = seeded(reefConfig.seed);
    reefEntityId = reefTick = 0; reefFinished = false; reefRound++;
    startGame(); phase = 'playing'; countdown = 0; $('countdown').hidden = true;
    reefStartedAt = reefLastPump = reefNow();
    reefFinishedWall = null; reefMaxGap = 0;
    reefOnStart(); renderAlpha = 1; draw(0);
    $('restart-button').disabled = true;
    return true;
  }
  // One-shot host hook: the host prepares the round, then the hook disappears.
  Object.defineProperty(window, '__fnPrepare', {configurable: true, value: options => {
    delete window.__fnPrepare; return reefPrepare(options);
  }});
  // This timer is independent of agents and render visibility. No tool advances time.
  setInterval(() => reefPump(reefNow()), 8);
`;

/** Default (packaged) hooks: no referee. */
const publicHooks = String.raw`
  function spawnWave() { reefOriginalSpawnWave(); }
  function sliceEntity(e, angle, speed) { reefOriginalSliceEntity(e, angle, speed); reefFinishIfNeeded(); }
  function reefRecordExit() {}
  function reefAfterTick() {}
  function reefOnStart() {}
  function reefOnFinish() {}
`;

/** Apply the public rules patch and the given hook block to the pinned upstream HTML. */
export function applyRules(html: string, hooks: string): string {
  let result = replaceOnce(
    html,
    '<meta charset="UTF-8">',
    `<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`,
  );
  // Derive the round clock from integer physics ticks; repeated float additions
  // otherwise make a 20-second round run one extra tick in the upstream game.
  result = replaceOnce(
    result,
    "elapsed+=realDt;remaining=",
    "elapsed=reefTick*FIXED_STEP;remaining=",
  );
  result = replaceOnce(
    result,
    "ambientTime+=Math.min(dt,.1);update(dt);",
    "ambientTime+=Math.min(dt,.1);reefPump(now);",
  );
  // Gameplay accepts native (trusted) pointer input only; dispatched events are ignored.
  result = result.replaceAll(
    "canvas.getBoundingClientRect()",
    "reefCanvasRect()",
  );
  result = replaceOnce(
    result,
    "canvas.addEventListener('pointerdown', e => {",
    "canvas.addEventListener('pointerdown', raw => { const e = reefReadPointer(raw); if (!e) return;",
  );
  result = replaceOnce(
    result,
    "e.preventDefault(); initAudio();",
    "reefApply(reefPreventDefault, raw, []); initAudio();",
  );
  result = replaceOnce(
    result,
    "if (phase !== 'playing' || e.button !== 0 || pointer) return;",
    "if (e.isTrusted !== true || phase !== 'playing' || e.button !== 0 || pointer) return;",
  );
  result = replaceOnce(
    result,
    "if(!pointer||pointer.id!==e.pointerId||phase!=='playing')return;",
    "if(e.isTrusted!==true||!pointer||pointer.id!==e.pointerId||phase!=='playing')return;",
  );
  result = replaceOnce(
    result,
    "canvas.addEventListener('pointermove', e => {",
    "canvas.addEventListener('pointermove', raw => { const e = reefReadPointer(raw); if (!e) return;",
  );
  result = replaceOnce(
    result,
    "e.preventDefault(); let samples=[];try{samples=e.getCoalescedEvents?.()||[];}catch{}\n    for(const sample of samples)moveBlade(sample);",
    "reefApply(reefPreventDefault, raw, []); let samples=[];try{samples=reefCoalesced?reefApply(reefCoalesced,raw,[]):[];}catch{}\n    for(const native of samples){const sample=reefReadPointer(native);if(sample)moveBlade(sample);}",
  );
  result = replaceOnce(
    result,
    "function endPointer(e) { if(pointer&&",
    "function endPointer(raw) { const e=reefReadPointer(raw); if(!e)return; if(pointer&&",
  );
  result = replaceOnce(
    result,
    "function pause() {",
    "function pause() { return; // realtime trials never pause\n",
  );
  result = replaceOnce(
    result,
    "function goHome() {",
    "function goHome() { if(reefRound) return; // preserve a single continuous round\n",
  );
  // A prepared round fixes mode, motion and arena geometry.
  result = replaceOnce(
    result,
    "function selectMode(mode) {",
    "function selectMode(mode) { if (reefLocked && mode !== reefConfig.mode) return;",
  );
  result = replaceOnce(
    result,
    "const motionEnabled = () => prefs.motion && !reducedMotion;",
    "const motionEnabled = () => !reefLocked && prefs.motion && !reducedMotion;",
  );
  result = replaceOnce(
    result,
    "function resize() {",
    "function resize() { if (reefLocked) return;",
  );
  result = replaceOnce(
    result,
    "$('start-button').addEventListener('click', startGame)",
    "$('start-button').addEventListener('click', reefStartPreparedGame)",
  );
  result = replaceOnce(
    result,
    "$('restart-button').addEventListener('click', startGame)",
    "$('restart-button').addEventListener('click', reefStartPreparedGame)",
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
    rulesSource +
      hooks +
      "\n  setSound(); updateBest(); resize(); requestAnimationFrame(frame);",
  );
}

/** The product given to builders: upstream game + public evaluation rules, no referee. */
export function packagedGame(html: string): string {
  return applyRules(html, publicHooks);
}
