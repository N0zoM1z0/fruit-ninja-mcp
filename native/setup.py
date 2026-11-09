#!/usr/bin/env python3
"""Acquire and unpack the pinned Windows research target locally."""
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local/windows"
URL = "https://archive.org/download/fruit-ninja-hd-portable/Fruit_Ninja_HD.7z"
ARCHIVE_SHA1 = "93dc48bf91ff9aacdb39289dad3b863b93e06cbd"
GAME_SHA256 = "1c40a38a42bd21ce7cc7e769a056c4338c44df9ef257c8efebd01144a4ebce3d"


def main():
    # Do not replace files that an active Wine process has mapped.
    prefix = str(LOCAL / "wine")
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            command = (process / "cmdline").read_bytes().split(b"\0")[0]
            environment = (process / "environ").read_bytes().split(b"\0")
            if command.endswith(b"FruitNinja.exe") and f"WINEPREFIX={prefix}".encode() in environment:
                raise SystemExit("Close this project's Windows game before running setup")
        except (OSError, PermissionError):
            continue
    if not shutil.which("7z"):
        raise SystemExit("7z is required to unpack the target")
    downloads = LOCAL / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / "Fruit_Ninja_HD.7z"
    if not archive.exists():
        temporary = archive.with_suffix(".partial")
        with urllib.request.urlopen(URL, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        temporary.rename(archive)
    if hashlib.sha1(archive.read_bytes()).hexdigest() != ARCHIVE_SHA1:
        raise SystemExit("Archive digest mismatch; refusing to unpack")
    subprocess.run(["7z", "x", "-y", str(archive), f"-o{downloads / 'archive'}"], check=True, stdout=subprocess.DEVNULL)
    installer = downloads / "archive/FruitNinjaHD161.exe"
    content = installer.read_bytes()
    # This installer embeds one Microsoft cabinet after its MSI metadata.
    offset = 0xA8400
    if content[offset:offset + 4] != b"MSCF":
        raise SystemExit("Unexpected installer cabinet layout")
    size = struct.unpack_from("<I", content, offset + 8)[0]
    if size != 83862470 or offset + size > len(content):
        raise SystemExit("Unexpected installer cabinet size")
    cabinet = downloads / "payload.cab"
    cabinet.write_bytes(content[offset:offset + size])
    game = LOCAL / "game"
    subprocess.run(["7z", "x", "-y", str(cabinet), f"-o{game}"], check=True, stdout=subprocess.DEVNULL)
    if hashlib.sha256((game / "FruitNinja.exe").read_bytes()).hexdigest() != GAME_SHA256:
        raise SystemExit("Game digest mismatch; refusing to use this target")
    manifest = {
        "title": "Fruit Ninja HD 1.6.1 (Windows)",
        "source": URL,
        "source_kind": "third-party historical archive; publisher authenticity unverified",
        "archive_sha1": ARCHIVE_SHA1,
        "installer_sha256": hashlib.sha256(content).hexdigest(),
        "game_sha256": GAME_SHA256,
        "cabinet_offset": hex(offset),
        "files": [{"name": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(game.iterdir()) if p.is_file()],
    }
    renderer = subprocess.run(["bash", str(ROOT / "native/build-dxvk.sh")], check=True, capture_output=True, text=True)
    renderer_path = Path(renderer.stdout.strip().splitlines()[-1])
    shutil.copy2(renderer_path, game / "d3d9.dll")
    manifest["renderer"] = {
        "name": "DXVK 2.4 with the Fruit Ninja singular-normal-matrix fix",
        "upstream_fix": "https://github.com/doitsujin/dxvk/pull/5765",
        "sha256": hashlib.sha256(renderer_path.read_bytes()).hexdigest(),
        "patch_sha256": hashlib.sha256((ROOT / "native/dxvk-2.4-fruit-ninja.patch").read_bytes()).hexdigest(),
    }
    (LOCAL / "target.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"game": str(game), "sha256": GAME_SHA256}))


if __name__ == "__main__":
    main()
