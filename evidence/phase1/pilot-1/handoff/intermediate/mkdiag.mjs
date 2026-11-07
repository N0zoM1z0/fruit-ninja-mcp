import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('/output/mcp/adapter.js', 'utf8');
const extra = `
/* ---- diagnostics (exploration only) ---- */
var EV = [];
(function () {
  var cv = document.getElementById('game');
  ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','mousedown','mousemove','mouseup'].forEach(function (t) {
    cv.addEventListener(t, function (e) {
      if (EV.length < 6000) EV.push({ t: t, x: Math.round(e.clientX * 10) / 10, y: Math.round(e.clientY * 10) / 10, ts: Math.round(e.timeStamp), trust: e.isTrusted });
    }, true);
  });
})();
exports.events = function (a) { return EV.slice(-((a && a.n) || 50)); };
exports.clearEvents = function () { EV.length = 0; return true; };
`;
writeFileSync('/output/intermediate/diag-adapter.js', src + extra);
console.log('written');
