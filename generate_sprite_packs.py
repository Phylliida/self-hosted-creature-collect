#!/usr/bin/env python3
"""Pre-crop sprite cells into per-partner binary "pack" files at build
time, so the runtime first-launch step can import them into IDB by
byte-slicing PNG bytes — no canvas decode + alpha-scan + re-encode on
every user's phone.

Why
---
Currently the sprite bundle ships untrimmed per-partner sheets (10×16
grid of 96×96 cells with transparent padding around each creature).
The runtime `bulkDownload` decodes each sheet (slow PNG decode), crops
every cell tight-bbox (canvas operations), re-encodes each crop as a
small PNG via `canvas.toBlob()` (slow), and writes to IDB. That's the
~30-60 second first-launch wait, AND iOS WKWebView's flaky `toBlob()`
timing is what produces the red-dot bug.

Moving the decode+crop work to Python at build time turns runtime
into pure byte-slicing: parse a small header, slice the payload into
Blobs, idbPut. Per-pack IDB transactions go from 22500+ down to 150,
which compounds the speedup. Net first-launch goes from ~30s to ~5s
on iOS, with no encode/decode work involved.

Pack format (per partner b at `data/BundledData/sprite-packs/<b>.pack`):
    Magic   : 4 bytes ASCII 'CRPP'
    Count   : u32 LE — number of cell entries in this pack
    Index   : Count × 16 bytes, each entry:
                u32 a       — partner-A id (1..150)
                i32 variant — -1 for autogen, 0+ for custom slot
                u32 offset  — byte offset into payload
                u32 length  — byte length
    Payload : concatenated tight-bbox PNG bytes for each cell

Variant slot semantics match `customKey(a, b, slot)` in sprites.js —
slot is the position in cells.json[`<a>-<b>`]'s variantIndices list.
The runtime looks up customKey(a, b, slot) to fetch a hand-drawn
variant; this script writes one pack entry per (a, slot) so that key
resolves directly.

Run:
    python3 generate_sprite_packs.py
"""

import json
import struct
import sys
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("error: pillow (PIL) not found. Add python3Packages.pillow to "
          "shell.nix and re-enter the shell.", file=sys.stderr)
    sys.exit(1)

# Mirror constants from build-bundled-data.py + static/sprites.js
# (kept in sync by hand — there are only three of them and they
# haven't changed in years).
MAX_SPECIES = 150
CELL_PX = 96
AUTOGEN_COLS = 10
CUSTOM_COLS = 20
ALPHA_MIN = 8

ROOT = Path(__file__).resolve().parent
BUNDLE_DIR = ROOT / "data" / "BundledData"
SPRITES_DIR = BUNDLE_DIR / "sprites"
PACKS_DIR = BUNDLE_DIR / "sprite-packs"
MANIFEST_PATH = BUNDLE_DIR / "manifest.json"
CELLS_PATH = BUNDLE_DIR / "cells.json"

PACK_MAGIC = b"CRPP"


def _trim_alpha(img: "Image.Image"):
    """Tight-bbox crop matching sprites.js's `scanAndCrop` semantics:
    any pixel with alpha > ALPHA_MIN is opaque, anything ≤ is
    transparent. Returns the cropped Image, or None if every pixel is
    transparent."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    alpha = img.split()[3]
    lut = [0 if a <= ALPHA_MIN else 255 for a in range(256)]
    mask = alpha.point(lut, mode="L")
    bbox = mask.getbbox()
    if bbox is None:
        return None
    return img.crop(bbox)


def _encode_png(img: "Image.Image") -> bytes:
    """Encode a PIL Image as PNG bytes. `optimize=True` would shave a
    few % but adds ~10× per-cell encode time — at 22500 cells that's
    minutes added to the build. Skip it; the size cost is small and
    the runtime doesn't care."""
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def _crop_autogen_cell(sheet: "Image.Image", a: int) -> bytes:
    """Crop autogen cell at column `a`. Falls back to the untrimmed
    96×96 if the cell is fully transparent — matches sprites.js's
    `cropAutogenCell` which keeps a placeholder PNG even when there's
    no art (rare for autogen since every body has art)."""
    col = a % AUTOGEN_COLS
    row = a // AUTOGEN_COLS
    x0, y0 = col * CELL_PX, row * CELL_PX
    x1, y1 = x0 + CELL_PX, y0 + CELL_PX
    if y1 > sheet.height:
        return None
    cell = sheet.crop((x0, y0, x1, y1))
    trimmed = _trim_alpha(cell)
    if trimmed is None:
        # Fallback to untrimmed 96×96 — same as sprites.js's behaviour.
        return _encode_png(cell)
    return _encode_png(trimmed)


def _crop_custom_cell(sheet: "Image.Image", a: int) -> "bytes | None":
    """Crop custom cell at column `a` (20-col grid). Returns None if
    the cell is blank — caller should skip blank cells, matching
    sprites.js's `cropCustomCell`."""
    col = a % CUSTOM_COLS
    row = a // CUSTOM_COLS
    x0, y0 = col * CELL_PX, row * CELL_PX
    x1, y1 = x0 + CELL_PX, y0 + CELL_PX
    if y1 > sheet.height:
        return None
    cell = sheet.crop((x0, y0, x1, y1))
    trimmed = _trim_alpha(cell)
    if trimmed is None:
        return None
    return _encode_png(trimmed)


def _build_one_pack(
    b: int,
    manifest_for_b: list,
    cells_for_b: dict,
) -> "bytes | None":
    """Build the binary pack for partner b. Returns the pack bytes or
    None if no cells could be cropped (e.g., autogen sheet missing).

    `manifest_for_b` is the list of variant suffixes (e.g.,
    `['', 'a', 'b']`). `cells_for_b` is the subset of cells.json keyed
    by partner-A id: `{a: [variant_index_for_slot_0, ...]}`."""
    autogen_path = SPRITES_DIR / str(b) / "autogen" / f"{b}.png"
    if not autogen_path.is_file():
        return None
    autogen_sheet = Image.open(autogen_path).convert("RGBA")

    entries = []  # list of (a, variant, png_bytes)

    # Pass 1 — autogen cells. variant = -1 sentinel.
    for a in range(1, MAX_SPECIES + 1):
        png = _crop_autogen_cell(autogen_sheet, a)
        if png is None:
            continue
        entries.append((a, -1, png))

    # Pass 2 — custom variants. Group by suffix so each variant sheet
    # is decoded exactly once even when many (a, slot) pairs reference
    # the same suffix.
    by_suffix = {}  # suffix -> [(a, slot), ...]
    for a, variant_indices in cells_for_b.items():
        for slot, vi in enumerate(variant_indices):
            if vi < 0 or vi >= len(manifest_for_b):
                continue
            suffix = manifest_for_b[vi]
            by_suffix.setdefault(suffix, []).append((a, slot))

    for suffix, cell_list in by_suffix.items():
        sheet_name = f"{b}{suffix}.png" if suffix else f"{b}.png"
        sheet_path = SPRITES_DIR / str(b) / "custom" / sheet_name
        if not sheet_path.is_file():
            continue
        sheet = Image.open(sheet_path).convert("RGBA")
        for a, slot in cell_list:
            png = _crop_custom_cell(sheet, a)
            if png is None:
                continue
            entries.append((a, slot, png))

    if not entries:
        return None

    # Pack into binary. Header + index + payload.
    out = BytesIO()
    out.write(PACK_MAGIC)
    out.write(struct.pack("<I", len(entries)))
    # Compute payload offsets first.
    offsets = []
    cursor = 0
    for _a, _v, png in entries:
        offsets.append(cursor)
        cursor += len(png)
    for (a, variant, png), offset in zip(entries, offsets):
        out.write(struct.pack("<IiII", a, variant, offset, len(png)))
    for _a, _v, png in entries:
        out.write(png)
    return out.getvalue()


def build_sprite_packs() -> tuple[int, int]:
    """Generate one pack file per partner species. Returns
    (pack_count, total_cells) for the build's progress log."""
    if not MANIFEST_PATH.is_file():
        print(f"error: {MANIFEST_PATH} missing — run "
              "build_sprites_and_manifest() first.", file=sys.stderr)
        return (0, 0)
    if not CELLS_PATH.is_file():
        print(f"error: {CELLS_PATH} missing — run "
              "build_sprites_and_manifest() first.", file=sys.stderr)
        return (0, 0)

    manifest = json.loads(MANIFEST_PATH.read_text())
    cells = json.loads(CELLS_PATH.read_text())

    # Index cells.json by head species so we can iterate one head at a
    # time. cells keys look like "<a>-<b>"; group by b.
    cells_by_head = {}
    for key, variant_indices in cells.items():
        dash = key.find("-")
        if dash <= 0:
            continue
        try:
            a = int(key[:dash])
            b = int(key[dash + 1:])
        except ValueError:
            continue
        if a < 1 or a > MAX_SPECIES or b < 1 or b > MAX_SPECIES:
            continue
        cells_by_head.setdefault(b, {})[a] = variant_indices

    PACKS_DIR.mkdir(parents=True, exist_ok=True)
    pack_count = 0
    total_cells = 0
    for b in range(1, MAX_SPECIES + 1):
        manifest_for_b = manifest.get(str(b)) or []
        cells_for_b = cells_by_head.get(b, {})
        pack_bytes = _build_one_pack(b, manifest_for_b, cells_for_b)
        if pack_bytes is None:
            continue
        pack_path = PACKS_DIR / f"{b}.pack"
        pack_path.write_bytes(pack_bytes)
        # Each entry is 16 bytes in the index — count is at offset 4.
        count = struct.unpack("<I", pack_bytes[4:8])[0]
        pack_count += 1
        total_cells += count
        if b % 10 == 0:
            size_kb = len(pack_bytes) // 1024
            print(f"  pack {b:3d}: {count:4d} cells, {size_kb:5d} KB")

    return pack_count, total_cells


def main() -> None:
    print(f"→ Building sprite packs into {PACKS_DIR}...")
    pack_count, total_cells = build_sprite_packs()
    if pack_count == 0:
        print("  no packs written", file=sys.stderr)
        sys.exit(1)
    print(f"  {pack_count} packs, {total_cells} cells total")


if __name__ == "__main__":
    main()
