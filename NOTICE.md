# Notice and redistribution status

**Base repository.** This branch of
[N0zoM1z0/fruit-ninja-mcp](https://github.com/N0zoM1z0/fruit-ninja-mcp) builds on its `main` at
commit `921455712a49eaa4a265ca7014a269b9d2dc3a03`, with complete history and authorship. Phase 0
was first developed in the private standalone repository `kaoru0822-kitauji/fruit-ninja-self-mcp`
and moved here with its commit hashes unchanged. This repository is publicly viewable but
contains no license file; public visibility does not grant a license to reuse or redistribute
the code.

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

**Windows research target.** `native/setup.py` acquires a hash-pinned third-party
historical Fruit Ninja HD archive locally. The inspected executable is Halfbrick
game software, distinct from the browser remake. Archive provenance and hashes
do not establish publisher authenticity. Binaries, assets, Wine state, decompiled
output and recordings are not vendored. The DXVK compatibility backport is an
altered upstream source patch under [the zlib/libpng license](native/DXVK-LICENSE.txt).
