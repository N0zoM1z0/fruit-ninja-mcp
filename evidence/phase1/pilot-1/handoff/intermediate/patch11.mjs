import { readFileSync, writeFileSync } from 'node:fs';
const p = '/output/mcp/server.js';
let s = readFileSync(p, 'utf8');
const a = `      'executes it. If no fruit is airborne it waits briefly for the next wave. ' +
      'Returns the score gained and the new state. Call start_round first.',`;
const b = `      'executes it. If no fruit is airborne it waits briefly for the next wave. ' +
      'Returns the score gained and the new state. If the round has not been started yet, ' +
      'this call presses the start button instead and reports reason "round-started".',`;
if (!s.includes(a)) { console.error('MISS'); process.exit(1); }
s = s.replace(a, b);
writeFileSync(p, s);
console.log('patched');
