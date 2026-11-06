// DEVELOPER FIXTURE adapter (positive and gui-wrapper variants). Test-only; never shown to builders.
// Observes rendering by wrapping Canvas 2D draw calls on the main game context.
const canvas = document.getElementById("game");
const main = canvas.getContext("2d");
const proto = CanvasRenderingContext2D.prototype;
const drawImage = proto.drawImage,
  clearRect = proto.clearRect;
let current = [],
  currentAt = 0,
  latest = [],
  latestAt = 0,
  previous = [],
  previousAt = 0,
  frames = 0;
proto.clearRect = function (...args) {
  if (this === main) {
    previous = latest;
    previousAt = latestAt;
    latest = current;
    latestAt = currentAt;
    current = [];
    currentAt = performance.now();
    frames++;
  }
  return clearRect.apply(this, args);
};
proto.drawImage = function (image, ...args) {
  if (
    this === main &&
    image &&
    image.width === 320 &&
    image.height === 320 &&
    args.length === 4
  ) {
    const m = this.getTransform();
    current.push({
      bx: m.e,
      by: m.f,
      br: ((args[2] * 124) / 320) * Math.hypot(m.a, m.b),
    });
  }
  return drawImage.call(this, image, ...args);
};
exports.observe = () => {
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width / canvas.width,
    sy = rect.height / canvas.height;
  const page = (o) => ({
    x: rect.left + o.bx * sx,
    y: rect.top + o.by * sy,
    r: o.br * sx,
  });
  const now = performance.now(),
    dt = (latestAt - previousAt) / 1000;
  const before = previous.map(page);
  const objects = latest.map(page).map((o) => {
    let best = null,
      distance = 90;
    for (const p of before) {
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < distance) {
        distance = d;
        best = p;
      }
    }
    return {
      x: o.x,
      y: o.y,
      r: o.r,
      vx: best && dt > 0 ? (o.x - best.x) / dt : 0,
      vy: best && dt > 0 ? (o.y - best.y) / dt : 0,
    };
  });
  return {
    frame: frames,
    age_ms: now - latestAt,
    objects,
    canvas: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    started: document.getElementById("menu").hidden === true,
    round_over: !!document.querySelector("#result-dialog[open]"),
  };
};
exports.locate_start = () => {
  const r = document.getElementById("start-button").getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    visible: r.width > 0,
  };
};
// Used by the gui-wrapper variant: relaying pixels must be refused by the game port.
exports.snapshot = () => canvas.toDataURL("image/png");
