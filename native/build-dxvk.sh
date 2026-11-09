#!/usr/bin/env bash
# Altered DXVK 2.4, zlib/libpng license: see DXVK-LICENSE.txt.
# Backports the singular-normal-matrix fix from upstream PR #5765 only.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/.local/windows/toolchain/dxvk-build"
SOURCE_DIR="$BUILD_ROOT/source"
BASE_COMMIT=008afc1c5f287e82a553108790da6e10b1159200
PATCH_FILE="$ROOT_DIR/native/dxvk-2.4-fruit-ninja.patch"
mkdir -p "$BUILD_ROOT"
for executable in git meson ninja i686-w64-mingw32-g++ curl dpkg-deb; do
  command -v "$executable" >/dev/null || { echo "Required tool missing: $executable" >&2; exit 1; }
done
if [ ! -d "$SOURCE_DIR/.git" ]; then
  git clone --depth 1 --branch v2.4 https://github.com/doitsujin/dxvk.git "$SOURCE_DIR" >&2
fi
test "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$BASE_COMMIT"
git -C "$SOURCE_DIR" submodule update --init --depth 1 >&2
if git -C "$SOURCE_DIR" apply --check "$PATCH_FILE" 2>/dev/null; then
  git -C "$SOURCE_DIR" apply "$PATCH_FILE"
else
  git -C "$SOURCE_DIR" apply --reverse --check "$PATCH_FILE"
fi
# Pin shader tools locally instead of changing system packages.
GLSLANG_DEB="$BUILD_ROOT/glslang-tools_12.0.0-2_amd64.deb"
if [ ! -f "$GLSLANG_DEB" ]; then
  curl --fail --location --max-time 120 --silent --show-error \
    https://deb.debian.org/debian/pool/main/g/glslang/glslang-tools_12.0.0-2_amd64.deb -o "$GLSLANG_DEB"
fi
echo "28e8cd493ccc83a7e803c637b5d96536400583730f3a70e7cc1431fa1585f819  $GLSLANG_DEB" | sha256sum --check >&2
dpkg-deb -x "$GLSLANG_DEB" "$BUILD_ROOT/tools"
export PATH="$BUILD_ROOT/tools/usr/bin:$PATH"
if [ ! -f "$BUILD_ROOT/build32/build.ninja" ]; then
  meson setup "$BUILD_ROOT/build32" "$SOURCE_DIR" \
    --cross-file "$SOURCE_DIR/build-win32.txt" --buildtype release \
    -Denable_dxgi=false -Denable_d3d8=false -Denable_d3d10=false -Denable_d3d11=false >&2
fi
ninja -C "$BUILD_ROOT/build32" -j4 src/d3d9/d3d9.dll >&2
printf '%s\n' "$BUILD_ROOT/build32/src/d3d9/d3d9.dll"
