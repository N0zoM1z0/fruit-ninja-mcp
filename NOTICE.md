# Notice and redistribution status

**Base repository.** This repository is derived from
[N0zoM1z0/fruit-ninja-mcp](https://github.com/N0zoM1z0/fruit-ninja-mcp) at commit
`921455712a49eaa4a265ca7014a269b9d2dc3a03`. Its complete history and authorship are preserved
here (remote `upstream`). The base repository is private and contains no license file, so no
license is granted by this repository either. Keep this repository private and obtain the base
owners' permission before any wider distribution.

**Game.** The game is [fruit-ninja-dojo](https://github.com/yongqixue99-hue/fruit-ninja-dojo) by
yongqixue99-hue, pinned to `63d0af1906181cceb9486ed85cc2b65ce6e6ba0d` (SHA-256
`6e072f6efc0f2bb69c98dede80ed524deda20f0004d27b7beb2e80f5c4ddf96f`). On 2026-11-06 the upstream
repository declared no license (GitHub API `license: null`). Its source and art are therefore
**not vendored**. `npm run setup` downloads the pinned file and verifies its hash; the packaged
and refereed builds are generated locally and kept out of git. Videos produced by `make preview`
show the game's rendering; keep them as local artifacts and do not publish them without the
game author's permission. Historical recordings under `recordings/` come from the base
repository. This is not the official Halfbrick game.

**Dependencies.** npm packages are pinned by lockfiles (`package-lock.json`,
`sandbox/toolchain/package-lock.json`) and installed at setup; base images are pinned by digest
in the `Makefile`.
