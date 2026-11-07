# Phase 0 independent audit (historical review notes)

> Historical record. An independent review of the Phase 0 implementation (`b5482c2`) and its
> evidence (`24bc2c0`), made while that work lived in the standalone repository
> `kaoru0822-kitauji/fruit-ninja-self-mcp`. Both commits moved to this branch unchanged, so the
> file references below still apply. The findings were not addressed when the work was migrated;
> they are kept as written, apart from naming.

**Overall: FAIL — gameplay input integrity is bypassable without a referee violation.**

Reviewed `kaoru0822-kitauji/fruit-ninja-self-mcp`: implementation
`b5482c2b2590a7b5cc8214bc3b4a235419b17ece`, evidence `24bc2c0`, and
`ARCHITECTURE.md`. Fresh review, 2026-11-07 UTC (November 6 Pacific), against
`reef:~/fruit-ninja-self-mcp-p0/release-b5482c2`. The remote checkout remained clean.

| Boundary                 | Verdict                            | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder isolation        | **PASS**                           | Actual `BuilderSandbox.start()` produced uid 10001, network `none`, read-only root, dropped capabilities, no-new-privileges, and no bind mounts. No credential environment names or evaluator canary appeared. Repository, artifacts, Docker socket, fixtures and evaluator paths were absent; `/opt` marker scan was empty. Packaged game SHA-256 was `f51d160e…b024`, matching the manifest. Public-only context assembly and controller routing agree with these observations (`package.ts:71–94`, `sandbox.ts:107–187`, `builder.ts:178–264`). |
| MCP / evaluator boundary | **PARTIAL**                        | Referee global is captured and deleted before adapter injection; scripts and prepare hook disappear. Existing hidden-route/global checks pass, and the generated-MCP image has no browser, game or host paths. No runtime seed, future-spawn list or private scoring object was obtained. However, the adapter's shared page realm permits the input mutation below.                                                                                                                                                                               |
| Gameplay integrity       | **FAIL**                           | Native input budget and path validation work, but an adapter can replace an individual trusted event's coalesced samples. A legal logged path then produces off-path scoring, with no integrity violation. GUI/pixel and automatic-planning restrictions also lack semantic enforcement.                                                                                                                                                                                                                                                           |
| Frozen handoff           | **PASS for the exercised handoff** | Independently rehashed the recorded bundle: handoff, verified inventory and play result all identify `fe99702c…8561`. Recorded adapter injection matches its frozen file: `9b3ae1a6…cd06`. Freeze tests reject changed bytes/modes and links. Play mounts only frozen `mcp/` and the port directory, read-only; dependencies outside the bundle are the declared public image/toolchain (`freeze.ts:180–211`, `sandbox.ts:194–229`, `play.ts:300–331`).                                                                                            |

Reading shipped JavaScript, including scoring/RNG formulas, DOM scores and Canvas draw calls,
is legitimate product inspection under the contract. It is distinct from reading evaluator
state. The architecture's acknowledged LCG inference and host-evaluation/CSP exception remain
limitations, not independently demonstrated evaluator leaks.

## Findings and fixes

**1. High: trusted event instances remain mutable.** `lockdown.ts:49–65` freezes prototypes
and global bindings, but not events. A capture listener installed by the adapter can use
`Object.defineProperty(e, "getCoalescedEvents", …)` on a real native pointer event. The game
checks the outer event's `isTrusted`, then consumes the substituted plain sample objects
without authenticating their coordinates. `upstream.ts:173–187` adds trust checks without
closing this lookup; `referee.ts:34–43` attributes any resulting slice to the active host stroke.

One focused run through the real port and `CallGate` submitted only
`(60,110) → (80,110), 100 ms`. A render-hook observation selected a fruit at approximately
`(289.2,743.7)`. Five native events were rewritten; **one fruit was sliced**, score 1.
The round finished at **8003 ms** for an 8000 ms duration, with
`violations: []`, `unattributed_slices: 0`, `lockdown: true`, and the slice marked attributed.
This was a port/runtime probe, not a full `runPlay` verdict or model run.

**Fix:** protect input consumption from adapter-controlled event properties. Capture and use
genuine native accessors/methods for coordinates, timestamps and coalesced samples before
loading untrusted code, or separate adapter execution from the input/game realm. Add a
regression requiring off-path samples to have no gameplay effect. Prototype freezing and
stroke attribution alone do not establish that commanded and consumed paths match.

**2. Medium: interface checks do not establish “no GUI wrapper / gameplay automation.”**
`port.ts:66–82` rejects image URLs and large base64 strings, but an adapter returning
`Array.from(main.getImageData(0,0,8,8).data)` passed through the real port with 256 numeric
samples. Pixel tiles therefore have an available representation; a complete image relay was
not attempted. `policy.ts:35–60` also accepted an explicitly described `harvest()` tool that
selects the best visible fruit and sends one path. The input budget restricts action count,
not who chooses the target; an MCP can perform that planning internally. The existing
“autopilot” fixture tests three paths per call, not autonomous selection of one path.

**Fix:** define permitted planning explicitly, inspect frozen implementations for prohibited
automation, and use controlled observation/input interfaces where enforcement is required.
Remove pixel-reading capability from the observation boundary if pixels must truly be
withheld. Renaming checks and payload heuristics cannot enforce these semantic restrictions.

**3. Lower-priority handoff robustness.** The measured handoff matches. However,
`scripts/play.ts:34–38` consumes only the handoff's path, not its expected SHA or smoke result;
image IDs are recorded while launches use mutable tags. Compare the handoff's expected SHA
with `verifyFrozen()` and launch the recorded image ID before relying on stronger replay
guarantees. No artifact substitution was observed, and this is not the primary blocker.

## Checks and reproduction

Used the existing release images: builder `583fbc4b…65cc`, play `1058a21a…110d`, evaluator
`5899361d…ac6a`. Re-ran only `boundary.test.ts`, `port.test.ts` and `unit-policy.test.ts`:
**11 passed, 0 failed/skipped**. The passing tests miss finding 1. Also performed one
builder/play isolation probe and one eight-second gameplay probe. No rebuild, model call,
deployment, commit, push or unrelated Docker cleanup occurred; no project containers remained.

On reef, the following wrapper reproduces the test environment with a read-only checkout:

```sh
cd ~/fruit-ninja-self-mcp-p0/release-b5482c2
audit_node() {
  docker run --rm -i --label fnsm.project=fruit-ninja-self-mcp \
    --label fnsm.role=audit --network none --read-only \
    --tmpfs /tmp:rw,exec,size=256m,mode=1777 --shm-size 1g --cpus 2 --memory 4g \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:$PWD:ro" -w "$PWD" \
    fruit-ninja-self-mcp/evaluator:b5482c2b2590 node --import tsx "$@"
}
audit_node --test --test-concurrency=1 \
  tests/boundary.test.ts tests/port.test.ts tests/unit-policy.test.ts
```

Minimal reproduction of the input mutation (fixture supplies render observation only;
private referee reads below are the reviewer's oracle, never adapter inputs):

```sh
audit_node --input-type=module <<'JS'
import {readFile, mkdtemp} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {GameRuntime} from './src/runtime.ts';
import {startPort} from './src/public/port.ts';
import {GamePortClient} from './src/public/port-client.ts';
import {CallGate, RuntimeBackend} from './src/evaluator/play.ts';
const g = await GameRuntime.launch(), gate = new CallGate(); let port;
try {
  await g.prepare({mode:'arcade', seed:42, duration_seconds:8});
  await g.injectAdapter(await readFile('dev-fixtures/mcp/adapter.js','utf8') + `
    let target = null;
    exports.arm = () => target = exports.observe().objects.find(o=>o.y>350&&o.y<750)||null;
    window.addEventListener('pointermove', e => {
      if (e.isTrusted && e.buttons===1 && target)
        Object.defineProperty(e, 'getCoalescedEvents', {value:()=>[
          {clientX:target.x-80,clientY:target.y,timeStamp:e.timeStamp},
          {clientX:target.x+80,clientY:target.y,timeStamp:e.timeStamp+1}]});
    }, true);
  `);
  const dir = await mkdtemp('/tmp/fnsm-audit-');
  port = await startPort({socketPath:dir+'/port.sock',backend:new RuntimeBackend(g,'standard'),gate});
  const c = new GamePortClient(dir+'/port.sock');
  const at = (await c.adapter('locate_start')).value;
  gate.begin(1); await c.click(at.x,at.y); gate.end(1);
  let target;
  for(let i=0;i<60&&!target;i++){target=(await c.adapter('arm')).value;if(!target)await sleep(50);}
  if(!target) throw new Error('No visible target');
  gate.begin(2);
  console.log(await c.path([{x:60,y:110,t_ms:0},{x:80,y:110,t_ms:100}]));
  gate.end(2);
  while((await g.scene()).phase==='playing') await sleep(100);
  console.log(JSON.stringify({target,scene:await g.scene(),integrity:await g.integrity(),events:await g.events()}));
} finally {await port?.close(); await g.close();}
JS
```

The recorded evidence honestly labels its mock/developer-fixture scope; it demonstrates
infrastructure operation, not autonomous builder success or benchmark superiority. Broader
browser/kernel attacks, seed recovery, long-run clock reliability and Phase 1 functional
acceptance were outside this proportional review. The concrete input bypass warrants repair
before treating `valid_gameplay` as evidence of enforced experimental integrity.
