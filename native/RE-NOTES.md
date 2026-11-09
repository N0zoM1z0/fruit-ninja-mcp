# Windows Fruit Ninja: REA findings

The target is the x86 `FruitNinja.exe` extracted locally from the third-party
[Fruit Ninja HD archive](https://archive.org/details/fruit-ninja-hd-portable).
The archive SHA-1 is `93dc48bf91ff9aacdb39289dad3b863b93e06cbd`;
the game executable SHA-256 is
`1c40a38a42bd21ce7cc7e769a056c4338c44df9ef257c8efebd01144a4ebce3d`.
These identify the inspected files; they do not authenticate an unmodified
official release. Executables, game assets, extracted resources and Wine state
remain under ignored `.local/windows/`.

Analysis used the local REA 6.8.0 MCP server with Ghidra 12.1.4. Raw responses and
the request log are retained in `.local/windows/evidence/rea/`; the reusable
offset manifest is [re-layout.json](re-layout.json). No source from third-party
game ports was consulted. Binary bytes, RTTI, references and decompilation were
used to recover the Windows interface. The planning strategy is independently
adapted from this project's existing browser pilot.

The first SourceForge candidate (`c4e84222...`) was rejected after its installer
reported invalid data. It is not the source of the analyzed game executable.
`setup.py` records the accepted installer, cabinet and game hashes locally.

## Mechanism recovered from the executable

The entity manager is at `0x5bfaf0`. Its pointer at `0x5c0b00` addresses an array
of list descriptors, one per entity type. Each descriptor is 12 bytes: sentinel
pointer at +0, count at +4. A list node has next/previous pointers at +0/+4 and
the entity pointer at +8. Fruit uses type index 0 and vtable `0x551be0`; Bomb
uses index 1 and vtable `0x551b28`. This permits bounded traversal of the active
lists without scanning the process heap. Fruit and Bomb allocation sizes are
`0x18c` and `0xb0`.

Both classes place position at +`0x10/0x14/0x18`, velocity at +`0x1c/0x20/0x24`, and collision-sphere pointer at +`0x38`. The sphere's float
at +`0x14` is a **linear radius**: collision code squares the radius itself.
Fruit's sliced byte is +`0xb8`; Bomb's exploded byte is +`0x68`. Pending removal
sets bit `0x10` in the common flags at +`0x0c`. Fruit also has a short interval
between accepting a slice and setting its sliced flag; +`0xbc` tracks that
pending transition.

Fruit acceleration is at +`0xa0/0xa4/0xa8`, time scale at +`0x98`; Bomb uses +`0x8c/0x90/0x94` and +`0xa8`. Initial vertical acceleration is -12. The update
uses `60 * (velocity * dt + 0.5 * acceleration * dt²)`, then changes stored
velocity by `acceleration * dt`. Thus velocity converts to world units per
simulation second with factor 60, and nominal vertical acceleration is -720.
Frozen, delayed, exploded and already sliced entities require separate handling.

The logical viewport is `480 × (480/aspect)` for aspect ≤1.5, otherwise
`(320*aspect) × 320`. Position uses an upward y axis. Host runtime observations
independently confirmed the centered mapping
`screenX = left + (worldX + W/2)*width/W`,
`screenY = top + (H/2 - worldY)*height/H`.
The pointer at `0x5b30bc` belongs to FruitCamera; it can apply zoom, rotation and
shake. The centered mapping describes the ordinary untransformed arena, not
every camera animation.

Current score is an int at `0x5b308c`; the current remaining-time float is at
`*(uint32*)0x5b30c0 + 0x104`. TimeControl writes this every frame and invokes
GameOver when time expires. `0x5b3072` is the pause byte, `0x5b3078` marks the
ended/menu state, and `0x5b31dc` holds the GameOverScreen pointer. The dispatch
byte at `0x5b3070` alone cannot distinguish a menu from a running round.
The host must observe the native start transition and combine timer, pause,
end flag and result-screen state.

## Evidence index

| Finding                   | REA operation / address | Evidence ID                                                           |
| ------------------------- | ----------------------- | --------------------------------------------------------------------- |
| Entity manager root       | pseudocode `0x4e7170`   | `ev_d20eb99e496ca78ede46efd6a72c457e06bdc636516b7da65fd9c4b084f3796b` |
| Active lists              | pseudocode `0x4e6c20`   | `ev_6e859e7751f79fa37e9b6fd4f309d8461beba0721275d9ecb1a5c1bd6d44018d` |
| Node layout               | pseudocode `0x40f3e0`   | `ev_b0c917704850ea8f53de9522d72fea482353aafd25c0473196bff528e20551dc` |
| Fruit motion              | pseudocode `0x4e0b00`   | `ev_6fa7d392e95ec32f0352f6cd17983c3e19c23e5f34cafcffc93f1c5601a457e6` |
| Bomb motion               | pseudocode `0x4e59e0`   | `ev_c67c4c363b6a101fd87f0e857b3ef1da9d1a4074780f64ce6762475a1e257c87` |
| Radius semantics          | pseudocode `0x429d20`   | `ev_f68ef4064c436c8a4235fa269a6e30106924d14bd272ebf300a34008c3462d63` |
| Live timer                | pseudocode `0x4a5b90`   | `ev_8abae02e5c8b2c07f6213137c05915a1b95710197d997d89bb54ea3b5538c85a` |
| GameOver pointer/flag     | pseudocode `0x50a5b0`   | `ev_f8ded783897ef618709ab04542921160cb6681b90ceec6fddb54c8e9745e1950` |
| Frame-time transformation | pseudocode `0x4925a0`   | `ev_f3983600cd2cf6c67fef2ef99171c7be5a7ad9ebfff3b9b937ce1f4c4258a7a5` |

## Runtime limits

Static recovery establishes layout and simulation equations, not observed input
success or wall-clock prediction accuracy. The host ran the executable under
Wine with DXVK 2.4 after Wine's built-in renderer stalled. Initial software rendering
was about 12 FPS, with observed simulation frame delta around 0.08 seconds.
The outer update clamps long frames and multiplies time by 0.94; bonuses and
freeze effects can further change simulation time. Estimate wall-time motion
from consecutive observations or use the measured simulation/wall-time ratio.
Do not treat nominal gravity or remaining game seconds as wall-clock values.

Runtime validation rejected `0x5b2b90` as a cumulative clock: the render callback
at `0x4922e0` clears it. The reader instead measures the cumulative unsigned
millisecond counter at `0x5b3210`, incremented by the outer update. This counter
truncates each frame's milliseconds, so its measured rate has quantization
error. Final live observations were around 0.92–0.94 simulation seconds per
wall second under ordinary rendering. Native input coordinates are absolute;
the failed short menu strokes were caused by remaining inside a collision
sphere, not by relative coordinate conversion.

The game accepts actual native mouse strokes; the observer reads process state.
No executable patch or score mutation is required by this mechanism. End-to-end
play scores, recordings and input verification belong to the host's runtime
evidence and are separate from the static findings above.

## Accuracy follow-up

The additional local REA bundles are in
`.local/windows/evidence/accuracy-rea-stage1/` and `accuracy-rea/`. Camera update
`0x5068a0` and transform `0x506af0` establish the active-effect gate at +`0x160`,
zoom at +`0x158`, angle at +`0x15c` and effective x/y offset as position minus
shake (+`0x14c/150` minus +`0x144/148`). Rotation is quantized by shifting the
unsigned angle right four bits into a 4096-entry circle. For centered y-up input,
the native screen-to-world transform rotates by the negative angle, multiplies
by zoom, and adds offset. World-to-screen uses its inverse. The knife caller
`0x4d4d30` selects that branch. Ordinary-camera runtime placement was checked;
active zoom/rotation only has static evidence and a coordinate round-trip check,
not an observed successful cut during such an effect.

| Finding                | Evidence ID                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| Camera update          | `ev_f3e0ef6a3b6f15dfd30c14b2bfa884c338b8cb9eec0a510c00ff553218a4c731` |
| Camera transform       | `ev_dbce5fcffad65e61be9cdc5218d6b592be6d4082206449f20245fb7e233d9d42` |
| Transform instructions | `ev_533f929b1f3c288254b5db7463a5cf900f29fdb9d3d0316b9b15c8fda600482b` |
| Knife transform branch | `ev_5ed54538c6083b4c3aa635fc5f4de3a001925ac2b974f237e18f1e08927d762f` |
| Slash update           | `ev_31eca9b01925b3fe5a3e6c9a09dde4fd890cf40da3033506434ff7b54f5f47fc` |
| Cut condition          | `ev_cb321a5a99085230407692e01f99d51ea3bd0322a54c4e0a4c78c41203b840dc` |

Fruit kind is byte +`0x3c`; +`0x84` is the native combo-group value (the current
telemetry retains the earlier name `wave`). Metadata comes from the table
pointer at `0x5b2adc`, stride `0x338`, with reward at +`0x314` and configured
effect key at +`0x32c`. The planner uses these as reward/priority hints. Runtime
traces include special fruit in the ordinary fruit list; their effects do not
require treating every entity class as another cut target.

SlashEntity uses vtable `0x551c44` in type list 3 and rotates pooled instances.
Its cut condition needs sufficient trail vertices and a nonzero line segment;
this is not proof that four distinct rendered frames must pass. Live inspection
found the current collider spans the midpoint of previous/current positions to
the current position. A stale pooled entity cannot identify the active blade.
Read-heavy blade probes perturb input timing, so experimental lag estimates
were not promoted into the final planner. The final implementation retains
outside-to-inside entry and short explicit endpoint holds.

Object addresses are reused. A planned target pointer remaining active after a
stroke is therefore a diagnostic hint, not a trustworthy missed-fruit counter.
The original game's settled NO FRUIT DROPPED bonus is stronger runtime evidence
of whole-round coverage. No process-memory write is used for these changes.
