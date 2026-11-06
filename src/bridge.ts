/** Runs inside the pinned game. Time is driven only by the browser monotonic clock. */
export const bridgeSource = String.raw`
  let reefRevision = 0, reefTick = 0, reefRound = 0, reefEntityId = 0;
  let reefSpawnRandom = seeded(1);
  const reefSpawnRand = (a, b) => a + reefSpawnRandom() * (b - a);
  let reefEvents = [], reefBombsHit = 0, reefEscaped = 0, reefSpawned = 0;
  let reefFinished = false, reefStartedAt = null, reefFinishedWall = null;
  let reefLastPump = 0, reefMaxGap = 0, reefPumping = false;
  let reefConfig = {mode: 'arcade', seed: 42, duration_seconds: 60};
  const reefRoundNumber = value => Math.round(value * 1000) / 1000;

  function reefEvent(type, extra = {}) {
    reefEvents.push({seq: reefEvents.length + 1, tick: reefTick,
      at_ms: reefRoundNumber(elapsed * 1000),
      wall_ms: reefStartedAt === null ? 0 : reefRoundNumber(performance.now() - reefStartedAt),
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
    if (!alive || !e.dead) return;
    if (e.bomb) reefBombsHit++;
    reefEvent(e.bomb ? 'bomb_hit' : 'fruit_sliced', {
      object_id: e.id, ...(e.bomb ? {} : {fruit: e.type}), points: score - before});
    reefFinishIfNeeded();
  }
  function reefRecordExit(e) {
    if (!e.bomb && phase === 'playing') {
      reefEscaped++;
      reefEvent('fruit_escaped', {object_id: e.id, fruit: e.type});
    }
  }
  function reefFinishIfNeeded() {
    if (['ending','result'].includes(phase) && !reefFinished) {
      reefFinished = true;
      reefFinishedWall = performance.now() - reefStartedAt;
      reefEvent('round_finished');
      if (phase === 'ending') { endDelay = 0; showResults(); }
    }
  }
  function reefPump(now = performance.now()) {
    now = Math.max(now, performance.now());
    if (reefStartedAt === null || phase !== 'playing' || reefPumping) return;
    reefPumping = true;
    try {
      reefMaxGap = Math.max(reefMaxGap, now - reefLastPump);
      reefLastPump = now;
      const targetTick = Math.floor((now - reefStartedAt) / (FIXED_STEP * 1000));
      while (reefTick < targetTick && phase === 'playing') {
        reefTick++;
        update(FIXED_STEP);
        reefFinishIfNeeded();
      }
      renderAlpha = 1;
    } finally { reefPumping = false; }
  }
  function reefScene() {
    reefPump();
    const now = performance.now();
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
  function reefPrepare(options) {
    if (reefRound) throw new Error('A session permits one round. Start a new server for another round.');
    if (!['classic','arcade','zen'].includes(options.mode)) throw new Error('Invalid game mode');
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 4294967295)
      throw new Error('Seed must be an unsigned 32-bit integer');
    if (options.duration_seconds !== undefined &&
        (!Number.isInteger(options.duration_seconds) || options.duration_seconds < 5 || options.duration_seconds > 90 || options.mode === 'classic'))
      throw new Error('Custom durations are 5..90 whole seconds in arcade or zen mode');
    reefConfig = {...options}; selectMode(options.mode);
    modes.arcade.seconds = options.mode === 'arcade' ? (options.duration_seconds ?? 60) : 60;
    modes.zen.seconds = options.mode === 'zen' ? (options.duration_seconds ?? 90) : 90;
    prefs.motion = false; soundOn = false; setSound();
    $('pause-button').disabled = true;
    return reefScene();
  }
  function reefStartPreparedGame() {
    if (reefRound) return false;
    selectMode(reefConfig.mode);
    reefSpawnRandom = seeded(reefConfig.seed);
    reefEntityId = reefTick = reefBombsHit = reefEscaped = reefSpawned = 0;
    reefEvents = []; reefFinished = false; reefRound++; reefRevision++;
    startGame(); phase = 'playing'; countdown = 0; $('countdown').hidden = true;
    reefStartedAt = reefLastPump = performance.now();
    reefFinishedWall = null; reefMaxGap = 0;
    reefEvent('round_started'); renderAlpha = 1; draw(0);
    $('restart-button').disabled = true;
    return true;
  }
  window.fruitNinjaMcp = {
    scene: reefScene,
    prepare: reefPrepare,
    start: () => {
      if (!reefStartPreparedGame()) throw new Error('ROUND_ALREADY_STARTED: resets and restarts are disabled');
      return reefScene();
    },
    markAction: expected => {
      reefPump();
      if (expected !== undefined && expected !== reefRevision)
        throw new Error('STALE_REVISION: another action has already executed');
      if (phase !== 'playing') throw new Error('ROUND_NOT_PLAYING');
      reefRevision++;
    },
    events: (after, limit) => {
      reefPump();
      return {events: reefEvents.filter(e => e.seq > after).slice(0, limit), last_seq: reefEvents.length};
    }
  };
  // This timer is independent of the actor and render visibility. No tool advances time.
  setInterval(() => reefPump(performance.now()), 8);
`;
