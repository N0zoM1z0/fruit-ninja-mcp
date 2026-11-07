import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/adapter.js';
let s = readFileSync(p, 'utf8');
const reps = [
  // candidate filter: only fruits the blade can actually reach (canvas is the pointer target)
  [`    if (p0.x < -tr.r || p0.x > ci.W + tr.r) continue;\n    if (p0.y < -tr.r * 2 || p0.y > ci.H + tr.r * 2) continue;`,
   `    if (p0.x < -tr.r * 0.9 || p0.x > ci.W + tr.r * 0.9) continue;\n    if (p0.y < -tr.r * 0.9 || p0.y > ci.H + tr.r * 0.9) continue;`],
  // clamp into the canvas rect (the only element that receives the blade), not the viewport
  [`  var out = [];\n  for (var i = 0; i < pts.length; i++) {\n    var px = clamp(ci.left + pts[i].x * ci.width / ci.W, 1, 1439);\n    var py = clamp(ci.top + pts[i].y * ci.height / ci.H, 1, 959);\n    out.push({ x: px, y: py, t_ms: Math.max(0, Math.round(pts[i].t_ms)) });\n  }`,
   `  var minX = ci.left + 1, maxX = ci.left + ci.width - 1;\n  var minY = ci.top + 1, maxY = ci.top + ci.height - 1;\n  var out = [];\n  for (var i = 0; i < pts.length; i++) {\n    var px = clamp(ci.left + pts[i].x * ci.width / ci.W, minX, maxX);\n    var py = clamp(ci.top + pts[i].y * ci.height / ci.H, minY, maxY);\n    out.push({ x: px, y: py, t_ms: Math.max(0, Math.round(pts[i].t_ms)) });\n  }`],
  [`    var last = out[0] || { x: ci.left + ci.W / 2, y: ci.top + ci.H / 2, t_ms: 0 };\n    out = [{ x: last.x, y: last.y, t_ms: 0 }, { x: clamp(last.x + 40, 1, 1439), y: last.y, t_ms: 40 }];`,
   `    var last = out[0] || { x: ci.left + ci.W / 2, y: ci.top + ci.H / 2, t_ms: 0 };\n    out = [{ x: last.x, y: last.y, t_ms: 0 }, { x: clamp(last.x + 40, minX, maxX), y: last.y, t_ms: 40 }];`],
];
for (const [a, b] of reps) {
  if (!s.includes(a)) { console.error('MISS:', JSON.stringify(a.slice(0, 80))); process.exit(1); }
  s = s.replace(a, b);
}
writeFileSync(p, s);
console.log('patched');
