'use strict';
/*
 * Fruit Ninja Dojo — in-page observation + planning adapter.
 *
 * The adapter only OBSERVES the page: it wraps Canvas 2D rendering entry points
 * (drawImage / fillRect / save / restore / clip / clearRect) to reconstruct the
 * entity list the game is drawing, and reads the HUD DOM for score / lives /
 * clock.  It never touches game rules, geometry, timing or input.
 *
 * Exports:
 *   observe(args) -> current game state (phase, score, entities, canvas mapping)
 *   plan(args)    -> one native mouse path (page CSS px) that sweeps the blade
 *                    through as many fruits as possible while clearing bombs
 *   ping(args)    -> liveness / diagnostics
 *
 * All internal times are milliseconds; velocities are px/s.
 */

/* ------------------------------------------------------------------ hooks */

var SPRITE = 320;
var CTX = CanvasRenderingContext2D.prototype;
var _drawImage = CTX.drawImage;
var _fillRect = CTX.fillRect;
var _save = CTX.save;
var _restore = CTX.restore;
var _clip = CTX.clip;
var _clearRect = CTX.clearRect;

var ctxState = new WeakMap();
function cst(c) {
  var s = ctxState.get(c);
  if (!s) { s = { clip: false, stack: [] }; ctxState.set(c, s); }
  return s;
}
CTX.save = function () { var s = cst(this); s.stack.push(s.clip); return _save.apply(this, arguments); };
CTX.restore = function () { var s = cst(this); if (s.stack.length) s.clip = s.stack.pop(); return _restore.apply(this, arguments); };
CTX.clip = function () { var s = cst(this); s.clip = true; return _clip.apply(this, arguments); };

var FRAMES = [];
var MAX_FRAMES = 400;
var cur = null;
var domCache = null;

function dom() {
  if (!domCache) {
    domCache = {
      menu: document.getElementById('menu'),
      hud: document.getElementById('hud'),
      result: document.getElementById('result-dialog'),
      score: document.getElementById('score'),
      time: document.getElementById('time'),
      lives: document.getElementById('lives'),
      mode: document.getElementById('mode-label'),
      canvas: document.getElementById('game'),
      start: document.getElementById('start-button')
    };
  }
  return domCache;
}

CTX.clearRect = function () {
  try {
    if (cur) processFrame(cur);
    var d = dom();
    if (d.menu && d.menu.hidden) {
      cur = { t: performance.now(), fruits: [], bombs: [] };
      FRAMES.push(cur);
      if (FRAMES.length > MAX_FRAMES) FRAMES.shift();
    } else {
      cur = null;
    }
  } catch (e) { /* never disturb the game */ }
  return _clearRect.apply(this, arguments);
};

CTX.drawImage = function (img) {
  try {
    if (cur && img && img.width === SPRITE && img.height === SPRITE && !cst(this).clip) {
      // 5-arg form: (img, dx, dy, dw, dh); 9-arg form: (img, sx, sy, sw, sh, dx, dy, dw, dh)
      var w = arguments.length >= 9 ? arguments[7] : arguments[3];
      if (typeof w === 'number' && w > 0) {
        var m = this.getTransform();
        cur.fruits.push({ x: m.e, y: m.f, r: w * 124 / SPRITE });
      }
    }
  } catch (e) { /* ignore */ }
  return _drawImage.apply(this, arguments);
};

CTX.fillRect = function (x, y, w, h) {
  try {
    if (cur && typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      // The bomb body is the only fillRect issued while a round is running:
      // rect(-r*.22, -r*1.12, r*.43, r*.26) in the bomb's local frame.
      if (Math.abs(w / h - 0.43 / 0.26) < 1e-3) {
        var m = this.getTransform();
        cur.bombs.push({ x: m.e, y: m.f, r: w / 0.43 });
      }
    }
  } catch (e) { /* ignore */ }
  return _fillRect.apply(this, arguments);
};

/* --------------------------------------------------------------- tracking */

var fruitTracks = [];
var bombTracks = [];
var nextId = 1;

function matchTracks(tracks, items, maxDist, t) {
  var used = new Array(items.length);
  var i, j;
  for (i = 0; i < items.length; i++) used[i] = false;
  var out = [];
  for (i = 0; i < tracks.length; i++) {
    var tr = tracks[i];
    var bi = -1, bd = maxDist;
    for (j = 0; j < items.length; j++) {
      if (used[j]) continue;
      var d = Math.hypot(items[j].x - tr.x, items[j].y - tr.y);
      if (d < bd) { bd = d; bi = j; }
    }
    if (bi >= 0) {
      used[bi] = true;
      var it = items[bi];
      tr.samples.push({ t: t, x: it.x, y: it.y });
      if (tr.samples.length > 26) tr.samples.shift();
      tr.x = it.x; tr.y = it.y; tr.r = it.r; tr.t = t;
      out.push(tr);
    }
  }
  for (j = 0; j < items.length; j++) {
    if (used[j]) continue;
    var n = items[j];
    out.push({ id: nextId++, x: n.x, y: n.y, r: n.r, t: t, vx: 0, vy: 0, samples: [{ t: t, x: n.x, y: n.y }] });
  }
  return out;
}

/** Least-squares fit of x = x0 + vx*t and y = y0 + vy*t + g*t^2/2 over the sample window. */
function fitVel(samples, g) {
  var n = samples.length;
  if (n < 2) return { vx: 0, vy: 0 };
  var t0 = samples[0].t;
  if (n === 2) {
    var dt = (samples[1].t - samples[0].t) / 1000;
    if (!(dt > 0)) return { vx: 0, vy: 0 };
    return { vx: (samples[1].x - samples[0].x) / dt, vy: (samples[1].y - samples[0].y) / dt - 0.5 * g * dt };
  }
  var sx = 0, sy = 0, st = 0, stt = 0, sxt = 0, syt = 0;
  for (var i = 0; i < n; i++) {
    var s = samples[i];
    var t = (s.t - t0) / 1000;
    var yy = s.y - 0.5 * g * t * t;
    sx += s.x; sy += yy; st += t; stt += t * t; sxt += s.x * t; syt += yy * t;
  }
  var den = n * stt - st * st;
  if (Math.abs(den) < 1e-12) return { vx: 0, vy: 0 };
  return { vx: (n * sxt - sx * st) / den, vy: (n * syt - sy * st) / den };
}

var ciCache = null;
var ciStamp = -1e9;
function canvasInfo() {
  var now = performance.now();
  if (ciCache && now - ciStamp < 500) return ciCache;
  var c = dom().canvas;
  var r = c.getBoundingClientRect();
  var dpr = r.width > 0 ? c.width / r.width : 1;
  ciCache = {
    left: r.left, top: r.top, width: r.width, height: r.height,
    W: c.width / dpr, H: c.height / dpr, dpr: dpr
  };
  ciStamp = now;
  return ciCache;
}

function processFrame(f) {
  fruitTracks = matchTracks(fruitTracks, f.fruits, 170, f.t);
  bombTracks = matchTracks(bombTracks, f.bombs, 170, f.t);
  var g = canvasInfo().H * 1.03;
  var i, v, sm, span;
  for (i = 0; i < fruitTracks.length; i++) {
    sm = fruitTracks[i].samples;
    v = fitVel(sm, g);
    span = (sm[sm.length - 1].t - sm[0].t) / 1000;
    fruitTracks[i].vx = v.vx;
    fruitTracks[i].vy = v.vy + g * span;   // fitVel reports the velocity at the OLDEST sample
  }
  for (i = 0; i < bombTracks.length; i++) {
    sm = bombTracks[i].samples;
    v = fitVel(sm, g);
    span = (sm[sm.length - 1].t - sm[0].t) / 1000;
    bombTracks[i].vx = v.vx;
    bombTracks[i].vy = v.vy + g * span;
  }
}

/* ------------------------------------------------------------- DOM state */

function readPhase() {
  var d = dom();
  if (d.result && d.result.open) return 'result';
  if (d.menu && !d.menu.hidden) return 'menu';
  if (d.hud && !d.hud.hidden) return 'playing';
  return 'unknown';
}
function readMode() {
  var d = dom();
  var t = d.mode ? (d.mode.textContent || '') : '';
  if (t.indexOf('\u7ecf\u5178') >= 0) return 'classic';
  if (t.indexOf('\u8857\u673a') >= 0) return 'arcade';
  if (t.indexOf('\u7985') >= 0) return 'zen';
  return null;
}
function readScore() {
  var d = dom();
  var v = parseInt(d.score ? d.score.textContent : '0', 10);
  return isFinite(v) ? v : 0;
}
function readMisses() {
  var d = dom();
  if (!d.lives) return 0;
  var n = 0, kids = d.lives.children;
  for (var i = 0; i < kids.length; i++) if (kids[i].className && kids[i].className.indexOf('lost') >= 0) n++;
  return n;
}
function readRemaining() {
  var d = dom();
  var v = parseFloat(d.time ? d.time.textContent : '0');
  return isFinite(v) ? v : 0;
}
function startButtonPoint() {
  var d = dom();
  if (!d.start || d.start.hidden || d.start.disabled) return null;
  var r = d.start.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function r2(v) { return Math.round(v * 100) / 100; }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/* --------------------------------------------------------------- exports */

exports.ping = function () {
  return {
    ok: true,
    frames: FRAMES.length,
    fruits: fruitTracks.length,
    bombs: bombTracks.length,
    phase: readPhase(),
    canvas: canvasInfo()
  };
};

exports.observe = function () {
  var now = performance.now();
  var f = FRAMES.length ? FRAMES[FRAMES.length - 1] : null;
  var ci = canvasInfo();
  var fruits = [], bombs = [], i;
  for (i = 0; i < fruitTracks.length; i++) {
    var t = fruitTracks[i];
    fruits.push({
      id: t.id, x: r2(t.x), y: r2(t.y), r: r2(t.r),
      vx: r2(t.vx), vy: r2(t.vy), age_ms: Math.round(now - t.t), n: t.samples.length
    });
  }
  for (i = 0; i < bombTracks.length; i++) {
    var b = bombTracks[i];
    bombs.push({
      id: b.id, x: r2(b.x), y: r2(b.y), r: r2(b.r),
      vx: r2(b.vx), vy: r2(b.vy), age_ms: Math.round(now - b.t), n: b.samples.length
    });
  }
  return {
    now: now,
    phase: readPhase(),
    mode: readMode(),
    score: readScore(),
    misses: readMisses(),
    remaining: readRemaining(),
    canvas: { left: ci.left, top: ci.top, width: ci.width, height: ci.height, W: r2(ci.W), H: r2(ci.H) },
    start_button: startButtonPoint(),
    frame_age_ms: f ? Math.round(now - f.t) : null,
    fruits: fruits,
    bombs: bombs
  };
};

/** Position of a track at absolute page time tAbs (ms), from its newest sample. */
function predictAt(tr, tAbs, g) {
  var dt = (tAbs - tr.t) / 1000;
  return { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt + 0.5 * g * dt * dt };
}

/** True when the straight blade segment a->b (wall times ta..tb, ms) clears every bomb. */
function segSafe(a, ta, b, tb, bombs, now, g, margin) {
  if (!bombs.length) return true;
  var len = Math.hypot(b.x - a.x, b.y - a.y);
  var steps = Math.max(2, Math.ceil(len / 12));
  for (var i = 0; i <= steps; i++) {
    var u = i / steps;
    var t = ta + (tb - ta) * u;
    var x = a.x + (b.x - a.x) * u;
    var y = a.y + (b.y - a.y) * u;
    for (var k = 0; k < bombs.length; k++) {
      var bm = bombs[k];
      var p = predictAt(bm.tr, t, g);
      var rr = bm.tr.r * 0.83 + margin;
      if (Math.hypot(p.x - x, p.y - y) < rr) return false;
    }
  }
  return true;
}

/**
 * Clamp into the canvas rect (the only element that receives the blade), enforce
 * strictly increasing integer t_ms, a >=20 ms duration and the 5000 px/s cap.
 */
function finalizePath(pts, ci) {
  var minX = ci.left + 1, maxX = ci.left + ci.width - 1;
  var minY = ci.top + 1, maxY = ci.top + ci.height - 1;
  var out = [];
  var i;
  for (i = 0; i < pts.length; i++) {
    var px = clamp(ci.left + pts[i].x * ci.width / ci.W, minX, maxX);
    var py = clamp(ci.top + pts[i].y * ci.height / ci.H, minY, maxY);
    out.push({ x: px, y: py, t_ms: Math.max(0, Math.round(pts[i].t_ms)) });
  }
  if (out.length < 2) {
    var last = out[0] || { x: ci.left + ci.W / 2, y: ci.top + ci.H / 2, t_ms: 0 };
    out = [{ x: last.x, y: last.y, t_ms: 0 }, { x: clamp(last.x + 40, minX, maxX), y: last.y, t_ms: 40 }];
  }
  for (i = 1; i < out.length; i++) if (out[i].t_ms <= out[i - 1].t_ms) out[i].t_ms = out[i - 1].t_ms + 1;
  var dur = out[out.length - 1].t_ms;
  if (dur < 20) {
    var k = 20 / Math.max(1, dur);
    for (i = 0; i < out.length; i++) out[i].t_ms = Math.round(out[i].t_ms * k);
    for (i = 1; i < out.length; i++) if (out[i].t_ms <= out[i - 1].t_ms) out[i].t_ms = out[i - 1].t_ms + 1;
  }
  for (;;) {
    for (i = 1; i < out.length; i++) {
      var a = out[i - 1], b = out[i];
      var d = Math.hypot(b.x - a.x, b.y - a.y);
      var need = Math.ceil(d / 4800 * 1000);
      if (b.t_ms - a.t_ms < need) b.t_ms = a.t_ms + Math.max(1, need);
    }
    if (out[out.length - 1].t_ms <= 1000 || out.length <= 2) break;
    out.pop();   // scaling down would break the speed cap, so shed the tail instead
  }
  return out;
}

exports.plan = function (args) {
  args = args || {};
  var ci = canvasInfo();
  var g = ci.H * 1.03;
  var now = performance.now();
  var lead = clamp(args.lead_ms == null ? 45 : Number(args.lead_ms), 0, 400);          // ms
  var speed = clamp(args.speed == null ? 3200 : Number(args.speed), 600, 4800);        // px/s
  var maxDur = clamp(args.max_duration_ms == null ? 900 : Number(args.max_duration_ms), 20, 1000); // ms
  var margin = args.bomb_margin == null ? 26 : Number(args.bomb_margin);
  // The native executor emits roughly one mouse sample per CDP round trip, so a
  // segment shorter than that round trip is stretched in wall time.  Keeping every
  // segment at least step_ms long keeps the blade on the planned schedule.
  var step = clamp(args.step_ms == null ? 40 : Number(args.step_ms), 8, 200);
  var T0 = now + lead;

  var cand = [];
  var i;
  for (i = 0; i < fruitTracks.length; i++) {
    var tr = fruitTracks[i];
    if (tr.samples.length < 2) continue;
    if (args.target_id != null && tr.id !== args.target_id) continue;
    var p0 = predictAt(tr, T0, g);
    if (p0.x < -tr.r * 0.9 || p0.x > ci.W + tr.r * 0.9) continue;
    if (p0.y < -tr.r * 0.9 || p0.y > ci.H + tr.r * 0.9) continue;
    cand.push({ tr: tr, p0: p0 });
  }
  if (!cand.length) return { ok: false, reason: 'no-fruits', phase: readPhase(), fruits: fruitTracks.length };

  var bombs = [];
  for (i = 0; i < bombTracks.length; i++) bombs.push({ tr: bombTracks[i] });

  var used = {};
  var chain = [];
  var curP = null, curT = T0;
  var guard = 0;

  while (guard++ < cand.length * 3 + 4) {
    var best = null, bd = Infinity;
    for (var c = 0; c < cand.length; c++) {
      var f = cand[c];
      if (used[f.tr.id]) continue;
      var pp = predictAt(f.tr, Math.max(curT, T0), g);
      var dd = curP ? Math.hypot(pp.x - curP.x, pp.y - curP.y) : Math.hypot(pp.x - ci.W / 2, pp.y - ci.H);
      if (dd < bd) { bd = dd; best = f; }
    }
    if (!best) break;
    used[best.tr.id] = true;

    var t;
    if (!curP) {
      t = T0;
    } else {
      t = curT + step;
      for (var it = 0; it < 5; it++) {
        var q = predictAt(best.tr, t, g);
        t = curT + Math.max(step, Math.hypot(q.x - curP.x, q.y - curP.y) / speed * 1000);
      }
    }
    if (t - T0 > maxDur) break;
    var p = predictAt(best.tr, t, g);
    if (curP && !segSafe(curP, curT, p, t, bombs, now, g, margin)) continue;
    chain.push({ id: best.tr.id, x: p.x, y: p.y, t: t });
    curP = p; curT = t;
  }

  if (!chain.length) return { ok: false, reason: 'no-chain', phase: readPhase(), fruits: cand.length, bombs: bombs.length };

  var pts = [];
  for (i = 0; i < chain.length; i++) pts.push({ x: chain[i].x, y: chain[i].y, t_ms: chain[i].t - T0 });
  if (pts.length === 1) {
    var onlyTr = null;
    for (i = 0; i < cand.length; i++) if (cand[i].tr.id === chain[0].id) onlyTr = cand[i].tr;
    var p2 = onlyTr ? predictAt(onlyTr, T0 + step, g) : { x: pts[0].x + 46, y: pts[0].y };
    if (Math.hypot(p2.x - pts[0].x, p2.y - pts[0].y) < 6) p2 = { x: pts[0].x + 46, y: pts[0].y };
    pts.push({ x: p2.x, y: p2.y, t_ms: step });
  }
  var out = finalizePath(pts, ci);
  return {
    ok: true,
    phase: readPhase(),
    points: out,
    targets: chain.map(function (c) { return c.id; }),
    duration_ms: out[out.length - 1].t_ms,
    lead_ms: Math.round(lead),
    step_ms: Math.round(step),
    fruits_seen: cand.length,
    bombs_seen: bombs.length
  };
};

exports.debug = function (args) {
  args = args || {};
  var n = args.n || 3;
  return {
    frames: FRAMES.slice(-n).map(function (f) {
      return { t: Math.round(f.t), fruits: f.fruits.map(function (x) { return [Math.round(x.x), Math.round(x.y), Math.round(x.r)]; }), bombs: f.bombs.map(function (x) { return [Math.round(x.x), Math.round(x.y), Math.round(x.r)]; }) };
    }),
    tracks: fruitTracks.map(function (t) { return { id: t.id, x: Math.round(t.x), y: Math.round(t.y), r: Math.round(t.r), vx: Math.round(t.vx), vy: Math.round(t.vy), n: t.samples.length }; }),
    bombs: bombTracks.map(function (t) { return { id: t.id, x: Math.round(t.x), y: Math.round(t.y), r: Math.round(t.r), vx: Math.round(t.vx), vy: Math.round(t.vy), n: t.samples.length }; })
  };
};
