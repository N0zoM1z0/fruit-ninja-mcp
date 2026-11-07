import { readFileSync, writeFileSync } from 'node:fs';
let s = readFileSync('/output/mcp/adapter.js', 'utf8');
const a = `    if (cur && img && img.width === SPRITE && img.height === SPRITE && !cst(this).clip) {
      var w = arguments[3];
      if (typeof w === 'number' && w > 0) {`;
const b = `    if (cur && img && img.width === SPRITE && img.height === SPRITE && !cst(this).clip) {
      // 5-arg form: (img, dx, dy, dw, dh); 9-arg form: (img, sx, sy, sw, sh, dx, dy, dw, dh)
      var w = arguments.length >= 9 ? arguments[7] : arguments[3];
      if (typeof w === 'number' && w > 0) {`;
if (!s.includes(a)) { console.error('MISS adapter'); process.exit(1); }
s = s.replace(a, b);
writeFileSync('/output/mcp/adapter.js', s);

let t = readFileSync('/output/mcp/server.js', 'utf8');
const c = `  const deadline = Date.now() + (opts.wait_ms ?? 1700);`;
const d = `  const deadline = Date.now() + (opts.wait_ms ?? 2500);`;
if (!t.includes(c)) { console.error('MISS server'); process.exit(1); }
t = t.replace(c, d);
t = t.replace(`.describe('How long to wait for fruit to appear before giving up (default 1700).'),`,
              `.describe('How long to wait for fruit to appear before giving up (default 2500).'),`);
writeFileSync('/output/mcp/server.js', t);
console.log('patched');
