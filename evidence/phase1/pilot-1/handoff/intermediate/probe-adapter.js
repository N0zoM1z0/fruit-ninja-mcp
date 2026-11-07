// Exploration adapter v2
const R = CanvasRenderingContext2D.prototype;
const orig = {
  drawImage: R.drawImage, ellipse: R.ellipse, fillRect: R.fillRect,
  save: R.save, restore: R.restore, clip: R.clip, clearRect: R.clearRect, arc: R.arc,
};
const st = new WeakMap();
function S(ctx) { let s = st.get(ctx); if (!s) { s = { clip: false, stack: [] }; st.set(ctx, s); } return s; }
R.save = function () { const s = S(this); s.stack.push(s.clip); return orig.save.apply(this, arguments); };
R.restore = function () { const s = S(this); if (s.stack.length) s.clip = s.stack.pop(); return orig.restore.apply(this, arguments); };
R.clip = function () { const s = S(this); s.clip = true; return orig.clip.apply(this, arguments); };

const log = [];
let frame = null;
function newFrame() {
  frame = { t: performance.now(), fruits: [], bombs: [], pieces: [], rects: [], arcs: [] };
  log.push(frame);
  if (log.length > 600) log.shift();
}
R.clearRect = function () { newFrame(); return orig.clearRect.apply(this, arguments); };
R.drawImage = function (img) {
  if (frame && img && img.width === 320 && img.height === 320) {
    const m = this.getTransform();
    const r = arguments[3] * 124 / 320;
    const rec = { x: m.e, y: m.f, r: r, a: Math.atan2(m.b, m.a) };
    (S(this).clip ? frame.pieces : frame.fruits).push(rec);
  }
  return orig.drawImage.apply(this, arguments);
};
R.fillRect = function (x, y, w, h) {
  if (frame) { const m = this.getTransform(); frame.rects.push({ x: m.e, y: m.f, w: w, h: h, t: typeof this.fillStyle }); }
  return orig.fillRect.apply(this, arguments);
};
R.ellipse = function (x, y, rx, ry) {
  if (frame) { const m = this.getTransform(); frame.arcs.push({ x: m.e, y: m.f, rx: rx, ry: ry, t: typeof this.fillStyle }); }
  return orig.ellipse.apply(this, arguments);
};

exports.ping = () => ({ ok: true, frames: log.length });
exports.dump = () => {
  const f = log[log.length - 1];
  return { frames: log.length, last: f ? { t: f.t, fruits: f.fruits.length, bombs: f.bombs.length, pieces: f.pieces.length, rects: f.rects, arcs: f.arcs.slice(0, 12) } : null };
};
exports.rect = (a) => {
  const el = document.getElementById(a.id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, hidden: el.hidden, disabled: el.disabled };
};
exports.dom = () => {
  const g = (id) => { const el = document.getElementById(id); return el ? { hidden: el.hidden, text: (el.textContent || '').slice(0, 60), cls: el.className } : null; };
  const c = document.getElementById('game');
  const rect = c.getBoundingClientRect();
  return {
    menu: g('menu'), hud: g('hud'), countdown: g('countdown'), score: g('score'), time: g('time'),
    wave: g('wave-label'), notice: g('miss-notice'),
    lives: [...document.getElementById('lives').children].map(x => x.className),
    resultOpen: document.getElementById('result-dialog').open,
    resultScore: g('result-score'),
    canvas: { w: c.width, h: c.height, rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height } },
    dpr: devicePixelRatio,
  };
};
exports.frames = (a) => {
  const n = (a && a.n) || 5;
  return log.slice(-n).map(f => ({ t: Math.round(f.t), fruits: f.fruits.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.r)]), bombs: f.bombs.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.r)]), pieces: f.pieces.length, rects: f.rects.length, arcs: f.arcs.length }));
};
exports.raw = (a) => log.slice(-((a && a.n) || 1));
exports.rate = () => {
  const n = Math.min(log.length, 60);
  if (n < 2) return null;
  const a = log[log.length - n], b = log[log.length - 1];
  return { frames: n, span_ms: b.t - a.t, hz: (n - 1) / ((b.t - a.t) / 1000) };
};
