// PRIVATE: evaluation-only referee. Never copied into builder/play images or shown to agents.
import { randomBytes } from "node:crypto";
import { applyRules } from "../upstream.js";

/**
 * Referee hooks compiled into the game's closure. The API object is registered under a
 * random one-time global key; the host captures it into a CDP handle and deletes the
 * key before lockdown and before any agent adapter runs. Agent code in the page main
 * world therefore has no reference to referee state, events or controls.
 */
function refereeHooks(key: string): string {
  return String.raw`
  // ===== Referee (private evaluation instrumentation) =====
  let reefRevision = 0, reefEvents = [], reefBombsHit = 0, reefEscaped = 0, reefSpawned = 0;
  const reefVisibleFruit = new Map();
  let reefVisibleSequence = 0, reefStroke = 0, reefStrokeEndedAt = -1e9, reefUnattributed = 0, reefBaseline = null;
  const reefViolations = [];
  const reefRoundNumber = value => Math.round(value * 1000) / 1000;
  function reefViolation(kind, detail) {
    if (!reefViolations.some(v => v.kind === kind))
      reefViolations.push({kind, detail: detail ?? null, tick: reefTick, at_ms: reefRoundNumber(elapsed * 1000)});
  }
  function reefEvent(type, extra = {}) {
    reefEvents.push({seq: reefEvents.length + 1, tick: reefTick,
      at_ms: reefRoundNumber(elapsed * 1000),
      wall_ms: reefStartedAt === null ? 0 : reefRoundNumber(reefNow() - reefStartedAt),
      type, ...extra});
  }
  function spawnWave() {
    const prior = reefEntityId;
    reefOriginalSpawnWave();
    reefSpawned += entities.filter(e => e.id > prior && !e.bomb).length;
  }
  function sliceEntity(e, angle, speed) {
    const alive = !e.dead, before = score;
    reefOriginalSliceEntity(e, angle, speed);
    if (alive && e.dead) {
      // Every scoring slice must happen during a host-executed native stroke.
      const attributed = reefStroke > 0 || reefNow() - reefStrokeEndedAt < 150;
      if (!attributed) { reefUnattributed++; reefViolation('unattributed_slice', {object_id: e.id}); }
      if (e.bomb) reefBombsHit++;
      reefEvent(e.bomb ? 'bomb_hit' : 'fruit_sliced', {
        object_id: e.id, ...(e.bomb ? {} : {fruit: e.type}), points: score - before, attributed});
    }
    reefFinishIfNeeded();
  }
  function reefRecordExit(e) {
    if (!e.bomb && phase === 'playing') {
      reefEscaped++;
      reefEvent('fruit_escaped', {object_id: e.id, fruit: e.type});
    }
  }
  function reefAfterTick() {
    for (const e of entities) {
      if (!e.dead && !e.bomb && !reefVisibleFruit.has(e.id) &&
          e.x+e.r>0 && e.x-e.r<W && e.y+e.r>0 && e.y-e.r<H)
        reefVisibleFruit.set(e.id, ++reefVisibleSequence);
    }
    if (reefTick % 12 === 0) reefCheck();
  }
  function reefOnStart() {
    reefBombsHit = reefEscaped = reefSpawned = 0;
    reefEvents = []; reefRevision++;
    reefVisibleFruit.clear(); reefVisibleSequence = 0;
    reefCheck();
    reefEvent('round_started');
  }
  function reefOnFinish() { reefCheck(); reefEvent('round_finished'); }
  function reefRect() {
    const r = reefCanvasRect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
  }
  // Rule/geometry integrity: agent code may not alter the arena, mode, motion or lockdown.
  function reefCheck() {
    if (!reefBaseline) return;
    const r = reefRect();
    if (['x','y','width','height'].some(k => Math.abs(r[k] - reefBaseline.rect[k]) > .5))
      reefViolation('canvas_rect_changed', {expected: reefBaseline.rect, actual: r});
    if (W !== reefBaseline.W || H !== reefBaseline.H) reefViolation('arena_changed', {W, H});
    if (motionEnabled()) reefViolation('motion_enabled');
    if (selectedMode !== reefConfig.mode) reefViolation('mode_changed', {mode: selectedMode});
    if (reefBaseline.lockdown && !Object.isFrozen(PointerEvent.prototype)) reefViolation('lockdown_lost');
  }
  function reefScene() {
    reefPump();
    const now = reefNow();
    return {schema_version: 2, round: reefRound, revision: reefRevision, tick: reefTick,
      phase: ['ending', 'result'].includes(phase) ? 'finished' : phase === 'playing' ? 'playing' : 'ready',
      mode: selectedMode, clock: 'realtime', elapsed_ms: reefRoundNumber(elapsed * 1000),
      remaining_ms: selectedMode === 'classic' ? null : reefRoundNumber(remaining * 1000),
      arena: {width: W, height: H}, gravity: reefRoundNumber(gravity()),
      clock_audit: {started_at_ms: reefStartedAt === null ? null : reefRoundNumber(reefStartedAt),
        observed_at_ms: reefRoundNumber(now),
        wall_elapsed_ms: reefStartedAt === null ? 0 : reefRoundNumber(now - reefStartedAt),
        finished_wall_elapsed_ms: reefFinishedWall === null ? null : reefRoundNumber(reefFinishedWall),
        max_pump_gap_ms: reefRoundNumber(reefMaxGap)},
      stats: {score, sliced, missed: misses, escaped_fruit: reefEscaped,
        bombs_hit: reefBombsHit, max_combo: maxCombo, spawned_fruit: reefSpawned},
      objects: entities.filter(e => !e.dead && e.x + e.r > 0 && e.x - e.r < W &&
        e.y + e.r > 0 && e.y - e.r < H).map(e => ({
          id: e.id, kind: e.bomb ? 'bomb' : 'fruit', fruit: e.bomb ? null : e.type,
          x: reefRoundNumber(e.x), y: reefRoundNumber(e.y),
          vx: reefRoundNumber(e.vx), vy: reefRoundNumber(e.vy),
          radius: reefRoundNumber(e.r), hit_radius: reefRoundNumber(e.r * (e.bomb ? .83 : 1.02))
        }))};
  }
  const reefApi = {
    scene: reefScene,
    observe: async options => {
      reefPump();
      const began = reefNow(), sequence = reefVisibleSequence;
      if (options.until === 'new_fruit' && phase === 'playing') {
        while (phase === 'playing' && reefVisibleSequence === sequence && reefNow() - began < options.timeout_ms) {
          await new Promise(done => setTimeout(done, 8));
          reefPump();
        }
      }
      const scene = reefScene();
      const ids = scene.objects.filter(e => e.kind === 'fruit' && (reefVisibleFruit.get(e.id) || 0) > sequence).map(e => e.id);
      const trigger = scene.phase === 'finished' ? 'round_finished' : scene.phase === 'ready' ? 'not_started' :
        options.until === 'immediate' ? 'immediate' : ids.length ? 'new_fruit' : 'timeout';
      return {scene, trigger, waited_ms: reefRoundNumber(reefNow() - began), new_fruit_ids: ids};
    },
    // Privileged start for the legacy reference MCP only. Play modes start with a native click.
    start: () => {
      if (!reefStartPreparedGame()) throw new Error('ROUND_ALREADY_STARTED: resets and restarts are disabled');
      return reefScene();
    },
    markAction: expected => {
      reefPump();
      if (expected !== undefined && expected !== reefRevision)
        throw new Error('STALE_REVISION: another action has already executed');
      if (phase !== 'playing') throw new Error('ROUND_NOT_PLAYING');
      reefRevision++; reefStroke++;
      return {scene: reefScene(), last_seq: reefEvents.length};
    },
    strokeBegin: () => { reefStroke++; },
    strokeEnd: () => { reefStroke = Math.max(0, reefStroke - 1); reefStrokeEndedAt = reefNow(); },
    events: (after, limit) => {
      reefPump();
      return {events: reefEvents.filter(e => e.seq > after).slice(0, limit), last_seq: reefEvents.length};
    },
    baseline: () => {
      reefBaseline = {rect: reefRect(), W, H, lockdown: Object.isFrozen(PointerEvent.prototype)};
      return reefBaseline;
    },
    integrity: () => {
      reefCheck();
      return {violations: reefViolations.map(v => ({...v})), unattributed_slices: reefUnattributed,
        lockdown: Object.isFrozen(PointerEvent.prototype), baseline: reefBaseline,
        config: {mode: reefConfig.mode, duration_seconds: modes[reefConfig.mode]?.seconds ?? null}};
    },
  };
  Object.defineProperty(window, ${JSON.stringify(key)}, {configurable: true, value: reefApi});
`;
}

/** A per-session refereed build. The key is random and deleted before agent code runs. */
export function refereedGame(html: string): { html: string; key: string } {
  const key = "__fnReferee_" + randomBytes(12).toString("hex");
  return { html: applyRules(html, refereeHooks(key)), key };
}

/** Markers that must never appear in builder/play images or agent-visible output. */
export const privateMarkers = [
  "reefApi",
  "reefViolation",
  "__fnReferee_",
  "unattributed_slice",
  "fruitNinjaMcp",
];
