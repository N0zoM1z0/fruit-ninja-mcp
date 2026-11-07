#!/usr/bin/env node
/*
 * Fruit Ninja Dojo — MCP server.
 *
 * Reaches the live game only through the game port (FN_GAME_PORT): adapter calls
 * for observation/planning and native mouse input for the blade.  Nothing is
 * written to stdout except MCP JSON-RPC frames.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request } from 'node:http';

const SOCKET = process.env.FN_GAME_PORT || '/run/fn/port.sock';
const log = (...a) => { try { process.stderr.write('[fn] ' + a.map(String).join(' ') + '\n'); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------ port client */

function portCall(method, path, payload, timeoutMs = 25000) {
  const data = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: SOCKET,
        path,
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('port returned non-JSON: ' + text.slice(0, 200)));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('port request timed out')));
    req.end(data);
  });
}

async function adapter(fn, args) {
  const r = await portCall('POST', '/v1/adapter', { fn, args: args ?? null });
  if (!r || r.ok !== true) {
    const e = (r && r.error) || {};
    throw new Error(`${e.code || 'PORT_ERROR'}: ${e.message || 'adapter call failed'}`);
  }
  return r.value;
}

async function sendPath(points) {
  const r = await portCall('POST', '/v1/input/path', { points, wait: true });
  if (!r || r.ok !== true) {
    const e = (r && r.error) || {};
    throw new Error(`${e.code || 'PORT_ERROR'}: ${e.message || 'path failed'}`);
  }
  return r;
}

async function sendClick(x, y) {
  const r = await portCall('POST', '/v1/input/click', { x, y });
  if (!r || r.ok !== true) {
    const e = (r && r.error) || {};
    throw new Error(`${e.code || 'PORT_ERROR'}: ${e.message || 'click failed'}`);
  }
  return r;
}

/* --------------------------------------------------------------- helpers */

/*
 * The native executor emits roughly one mouse sample per CDP round trip, so a
 * path segment shorter than that round trip is stretched in wall time and the
 * blade falls behind the fruit.  `step` is the minimum per-segment duration and
 * `lead` the delay between planning and the blade reaching the first point.
 * Both are calibrated from the measured execution time of previous strokes.
 */
let stepMs = 70;
let leadMs = 80;
let lastRtt = 40;

function summarize(s) {
  if (!s) return null;
  return {
    phase: s.phase,
    mode: s.mode,
    score: s.score,
    misses: s.misses,
    remaining: s.remaining,
    fruits: (s.fruits || []).length,
    bombs: (s.bombs || []).length,
  };
}

function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

async function observe() {
  return adapter('observe', {});
}

/* Serialize tool calls: the port executes one native input at a time and rejects
 * overlapping requests with BUSY, so never let two tools race. */
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Plan one stroke, waiting briefly for fruit to appear. */
async function planStroke(opts) {
  const deadline = Date.now() + (opts.wait_ms ?? 2500);
  let plan = null;
  for (;;) {
    const t0 = Date.now();
    plan = await adapter('plan', {
      lead_ms: Math.round(leadMs),
      step_ms: Math.round(stepMs),
      speed: opts.speed,
      max_duration_ms: opts.max_duration_ms,
      bomb_margin: opts.bomb_margin,
      target_id: opts.target_id,
    });
    lastRtt = Date.now() - t0;
    if (plan.ok) break;
    if (plan.phase && plan.phase !== 'playing') break;
    if (plan.reason !== 'no-fruits') break;
    if (Date.now() >= deadline) break;
    await sleep(50);
  }
  return plan;
}

/** Fold the measured execution time back into the timing calibration. */
function calibrate(plan, actualMs) {
  if (!plan || !plan.ok || !Number.isFinite(actualMs)) return;
  const segs = Math.max(1, plan.points.length - 1);
  const observed = (actualMs - plan.duration_ms) / segs;
  if (!Number.isFinite(observed)) return;
  stepMs = clamp(0.75 * stepMs + 0.25 * observed, 30, 130);
  leadMs = clamp(stepMs + lastRtt + 10, 30, 200);
}

async function stroke(opts) {
  let before = await observe();
  if (before.phase === 'menu' && before.start_button) {
    // Safety net: the round has not been started yet, so spend this call's single
    // native input on the start button instead of on a stroke.
    await sendClick(Math.round(before.start_button.x), Math.round(before.start_button.y));
    await sleep(150);
    before = await observe();
    return {
      sliced: false,
      reason: 'round-started',
      note: 'The round was not running, so the start button was clicked. Call slice again to strike.',
      state: summarize(before),
    };
  }
  if (before.phase !== 'playing') {
    return { sliced: false, reason: 'round-not-playing', state: summarize(before) };
  }
  const plan = await planStroke(opts);
  if (!plan.ok) {
    return { sliced: false, reason: plan.reason, state: summarize(before) };
  }
  const res = await sendPath(plan.points);
  const actual = res.previous_action && res.previous_action.actual_duration_ms;
  calibrate(plan, actual);
  await sleep(60);
  const after = await observe();
  return {
    sliced: true,
    targets: plan.targets.length,
    duration_ms: plan.duration_ms,
    points: plan.points.length,
    score_before: before.score,
    score_after: after.score,
    gained: after.score - before.score,
    state: summarize(after),
  };
}

/* ----------------------------------------------------------------- tools */

const server = new McpServer({ name: 'fruit-ninja-dojo', version: '1.0.0' });

server.registerTool(
  'game_state',
  {
    title: 'Read game state',
    description:
      'Read the live Fruit Ninja Dojo state: phase (menu/playing/result), mode, score, ' +
      'misses, seconds remaining, the airborne fruits and bombs with positions and ' +
      'velocities in arena coordinates, and the start button position. Read-only; sends no input.',
    inputSchema: {},
  },
  async () =>
    serialize(async () => {
    const s = await observe();
    return text({
      phase: s.phase,
      mode: s.mode,
      score: s.score,
      misses: s.misses,
      remaining: s.remaining,
      canvas: s.canvas,
      start_button: s.start_button,
      fruits: s.fruits,
      bombs: s.bombs,
      frame_age_ms: s.frame_age_ms,
    });
    }),
);

server.registerTool(
  'start_round',
  {
    title: 'Start the round',
    description:
      'Click the start button with a native mouse click to begin the prepared round. ' +
      'Only a native click can start the round. Returns the resulting game state.',
    inputSchema: {},
  },
  async () =>
    serialize(async () => {
      const s = await observe();
      if (s.phase === 'playing') return text({ started: false, reason: 'already-playing', state: summarize(s) });
      if (!s.start_button) return text({ started: false, reason: 'no-start-button', state: summarize(s) });
      await sendClick(Math.round(s.start_button.x), Math.round(s.start_button.y));
      await sleep(150);
      const after = await observe();
      return text({ started: true, state: summarize(after) });
    }),
);

server.registerTool(
  'slice',
  {
    title: 'Slice a stroke through the fruit',
    description:
      'Perform one blade stroke: the server observes the arena, plans a single native mouse ' +
      'path that sweeps through as many fruits as possible while keeping clear of bombs, and ' +
      'executes it. If no fruit is airborne it waits briefly for the next wave. ' +
      'Returns the score gained and the new state. If the round has not been started yet, ' +
      'this call presses the start button instead and reports reason "round-started".',
    inputSchema: {
      max_duration_ms: z
        .number()
        .int()
        .min(20)
        .max(1000)
        .optional()
        .describe('Upper bound on the stroke duration in milliseconds (default 900).'),
      speed: z
        .number()
        .min(600)
        .max(4800)
        .optional()
        .describe('Blade speed in arena px/s used while planning (default 3200).'),
      bomb_margin: z
        .number()
        .min(0)
        .max(200)
        .optional()
        .describe('Extra clearance in px kept from bomb centres (default 26).'),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe('How long to wait for fruit to appear before giving up (default 2500).'),
    },
  },
  async (args) => text(await serialize(() => stroke(args || {}))),
);

server.registerTool(
  'slice_fruit',
  {
    title: 'Slice one specific fruit',
    description:
      'Perform one blade stroke aimed at a single fruit id reported by game_state, then ' +
      'continue through any other fruit that lies along the way. Use this when you want ' +
      'precise control (for example to pick off a fruit near a bomb).',
    inputSchema: {
      fruit_id: z.number().int().describe('The id of the fruit to slice, from game_state.'),
      max_duration_ms: z.number().int().min(20).max(1000).optional(),
      speed: z.number().min(600).max(4800).optional(),
      bomb_margin: z.number().min(0).max(200).optional(),
    },
  },
  async (args) => text(await serialize(() => stroke({ ...(args || {}), target_id: args.fruit_id, wait_ms: 0 }))),
);

/* ------------------------------------------------------------------ boot */

const transport = new StdioServerTransport();
await server.connect(transport);
log('ready on', SOCKET);
