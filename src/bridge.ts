/** Injected inside the pinned game's closure. All hits use its pointer handlers. */
export const bridgeSource = String.raw`
  let reefRevision = 0, reefTick = 0, reefRound = 0, reefEntityId = 0;
  let reefSpawnRandom = seeded(1);
  const reefSpawnRand = (a, b) => a + reefSpawnRandom() * (b - a);
  let reefEvents = [], reefBombsHit = 0, reefEscaped = 0, reefSpawned = 0;
  let reefFinished = false;
  const reefRoundNumber = value => Math.round(value * 1000) / 1000;

  function reefEvent(type, extra = {}) {
    reefEvents.push({seq: reefEvents.length + 1, tick: reefTick,
      at_ms: reefRoundNumber(elapsed * 1000), type, ...extra});
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
  function reefDraw() {
    renderAlpha = 1;
    draw(elapsed);
  }
  function reefObjects() {
    return entities.filter(e => !e.dead && e.x + e.r > 0 && e.x - e.r < W &&
      e.y + e.r > 0 && e.y - e.r < H).map(e => ({
        id: e.id, kind: e.bomb ? 'bomb' : 'fruit', fruit: e.bomb ? null : e.type,
        x: reefRoundNumber(e.x), y: reefRoundNumber(e.y),
        vx: reefRoundNumber(e.vx), vy: reefRoundNumber(e.vy),
        radius: reefRoundNumber(e.r), hit_radius: reefRoundNumber(e.r * (e.bomb ? .83 : 1.02))
      }));
  }
  function reefScene() {
    return {schema_version: 1, round: reefRound, revision: reefRevision, tick: reefTick,
      phase: ['ending', 'result'].includes(phase) ? 'finished' : phase === 'playing' ? 'playing' : 'ready',
      mode: selectedMode, clock: 'decision', elapsed_ms: reefRoundNumber(elapsed * 1000),
      remaining_ms: selectedMode === 'classic' ? null : reefRoundNumber(remaining * 1000),
      arena: {width: W, height: H}, gravity: reefRoundNumber(gravity()),
      stats: {score, sliced, missed: misses, escaped_fruit: reefEscaped,
        bombs_hit: reefBombsHit, max_combo: maxCombo, spawned_fruit: reefSpawned},
      objects: reefObjects()};
  }
  function reefCheckRevision(revision) {
    if (revision !== reefRevision) throw new Error('STALE_SCENE: expected revision ' + reefRevision +
      ', received ' + revision + '. Read get_scene and plan again. Nothing was executed.');
    if (phase !== 'playing') throw new Error('ROUND_NOT_PLAYING: start a new game or inspect the final scene.');
  }
  function reefFinishIfNeeded() {
    if (['ending','result'].includes(phase) && !reefFinished) {
      reefFinished = true;
      reefEvent('round_finished');
      if (phase === 'ending') { endDelay = 0; showResults(); }
    }
  }
  function reefStep() {
    if (phase !== 'playing') return false;
    reefTick++;
    update(FIXED_STEP);
    renderAlpha = 1;
    reefFinishIfNeeded();
    return true;
  }
  function reefDispatch(type, point, ms) {
    const rect = canvas.getBoundingClientRect();
    const event = new PointerEvent(type, {pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true,
      cancelable: true, clientX: rect.left + point.x * rect.width / W,
      clientY: rect.top + point.y * rect.height / H});
    Object.defineProperty(event, 'timeStamp', {value: 1000 + ms});
    canvas.dispatchEvent(event);
  }
  window.fruitNinjaMcp = {
    scene: reefScene,
    events: (after, limit) => ({events: reefEvents.filter(e => e.seq > after).slice(0, limit),
      last_seq: reefEvents.length}),
    newGame: options => {
      if (!['classic','arcade','zen'].includes(options.mode)) throw new Error('Invalid game mode');
      if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 4294967295)
        throw new Error('Seed must be an unsigned 32-bit integer');
      if (options.duration_seconds !== undefined &&
          (!Number.isInteger(options.duration_seconds) || options.duration_seconds < 5 || options.duration_seconds > 90 || options.mode === 'classic'))
        throw new Error('Custom durations are 5..90 whole seconds in arcade or zen mode');
      selectMode(options.mode);
      modes.arcade.seconds = options.mode === 'arcade' ? (options.duration_seconds ?? 60) : 60;
      modes.zen.seconds = options.mode === 'zen' ? (options.duration_seconds ?? 90) : 90;
      reefSpawnRandom = seeded(options.seed);
      reefEntityId = reefTick = reefBombsHit = reefEscaped = reefSpawned = 0;
      reefEvents = []; reefFinished = false; reefRound++; reefRevision++;
      // Keep particle art; disable camera shake and cinematic slow motion for precise clocks.
      prefs.motion = false; soundOn = false; setSound();
      startGame(); phase = 'playing'; countdown = 0; $('countdown').hidden = true;
      reefDraw(); return reefScene();
    },
    wait: options => {
      reefCheckRevision(options.expected_revision);
      if (!Number.isInteger(options.duration_ms) || options.duration_ms < 1 || options.duration_ms > 3000)
        throw new Error('Wait duration must be 1..3000 milliseconds');
      const firstTick = reefTick, firstEvent = reefEvents.length;
      for (let i = 0; i < Math.ceil(options.duration_ms / (FIXED_STEP * 1000)); i++) {
        if (options.until_objects && reefObjects().length) break;
        if (!reefStep()) break;
      }
      reefRevision++; reefDraw();
      return {scene: reefScene(), advanced_ms: reefRoundNumber((reefTick - firstTick) * FIXED_STEP * 1000),
        events: reefEvents.slice(firstEvent)};
    },
    swipe: options => {
      reefCheckRevision(options.expected_revision);
      const points = options.points;
      if (!Array.isArray(points) || points.length < 2 || points.length > 32)
        throw new Error('A swipe needs 2..32 timed points');
      for (let i = 0; i < points.length; i++) {
        const p = points[i], previous = points[i-1];
        if (![p.x,p.y,p.t_ms].every(Number.isFinite) || p.x < 0 || p.x > W || p.y < 0 || p.y > H ||
            !Number.isInteger(p.t_ms) || (i === 0 ? p.t_ms !== 0 : p.t_ms <= previous.t_ms))
          throw new Error('Points must be inside the arena; integer t_ms starts at 0 and strictly increases');
        if (previous && Math.hypot(p.x-previous.x,p.y-previous.y) / ((p.t_ms-previous.t_ms)/1000) > 5000)
          throw new Error('Blade speed exceeds 5000 px/s; increase segment duration');
      }
      const total = points[points.length-1].t_ms;
      if (total < 16 || total > 1000) throw new Error('A swipe must last 16..1000 milliseconds');
      const firstTick = reefTick, firstEvent = reefEvents.length, start = elapsed * 1000;
      reefDispatch('pointerdown', points[0], start);
      let segment = 1, lastPoint = points[0];
      try {
        const ticks = Math.ceil(total / (FIXED_STEP * 1000));
        for (let i = 1; i <= ticks; i++) {
          if (!reefStep() || phase !== 'playing') break;
          const t = Math.min(total, i * FIXED_STEP * 1000);
          // Preserve every corner, including knots between fixed physics ticks.
          while (segment < points.length && points[segment].t_ms <= t) {
            lastPoint = points[segment];
            reefDispatch('pointermove', lastPoint, start + points[segment].t_ms);
            segment++;
          }
          if (segment < points.length) {
            const a = points[segment-1], b = points[segment], alpha = (t-a.t_ms)/(b.t_ms-a.t_ms);
            lastPoint = {x: a.x+(b.x-a.x)*alpha, y: a.y+(b.y-a.y)*alpha};
            reefDispatch('pointermove', lastPoint, start + t);
          }
        }
      } finally { reefDispatch('pointerup', lastPoint, elapsed * 1000); }
      reefRevision++; reefDraw();
      return {scene: reefScene(), advanced_ms: reefRoundNumber((reefTick-firstTick)*FIXED_STEP*1000),
        events: reefEvents.slice(firstEvent)};
    }
  };
`;
