"""cells-dupes.bin: which hand-drawn art slots are byte-for-byte copies.

Many cells list the same picture under more than one slot (about half of
all slots copy another slot of the same cell, mostly slot 0). This maps
every slot to the first slot of its cell with the same PNG bytes, so the
app counts distinct art (the species dex's all-art ring, the Summary's
art %) the way the fusion view's art grid already shows it.

Format: b'CRDP', then u32 LE slot count, u32 LE cell count and u32 LE
shape hash, then one byte per slot (its canonical slot). Cells come in the
order static/sprites.js builds its compact cells table (non-empty
cells.json entries sorted by a * 65536 + b), slots in cells.json order —
the app reads the bytes as one Uint8Array aligned with that table's value
array. The shape hash (FNV-1a over each cell's u32 LE key and u8 slot
count, in that order) lets the app refuse a file built for different
cells (another pack, or another version of this one).

The same bytes also go out gzipped and base64-encoded as
static/art-dupes.txt (write_refresh_copy): players who installed the
pack before the .bin existed get it with their next Refresh, which only
carries text safely on iOS.

Used by generate_sprite_packs.py (default bundle) and build-if2-packs.py
(each sliced IF2 pack). No heavy imports, so either can call it.
"""
import base64
import gzip
import hashlib
import json
import struct
from pathlib import Path

PACK_MAGIC = b"CRPP"
DUPES_MAGIC = b"CRDP"


def build_art_dupes(packs_dir: Path, cells_path: Path, out_path: Path) -> int:
    """Write out_path from the .pack files in packs_dir and cells_path.
    Slots missing from the packs map to themselves. Returns the number of
    cells with at least one duplicate slot."""
    cells = json.loads(Path(cells_path).read_text())
    digests = {}   # (a, b, slot) -> sha256
    for pack_path in Path(packs_dir).glob("*.pack"):
        b = int(pack_path.stem)
        buf = pack_path.read_bytes()
        if buf[:4] != PACK_MAGIC:
            continue
        count = struct.unpack_from("<I", buf, 4)[0]
        payload = 8 + 16 * count
        for i in range(count):
            a, variant, offset, length = struct.unpack_from("<IiII", buf, 8 + 16 * i)
            if variant >= 0:
                digests[(a, b, variant)] = hashlib.sha256(
                    buf[payload + offset: payload + offset + length]).digest()
    order = []
    for key, slots in cells.items():
        if not isinstance(slots, list) or not slots:
            continue
        a, b = (int(x) for x in key.split("-"))
        order.append((a * 65536 + b, a, b, len(slots)))
    order.sort()
    out_bytes = bytearray()
    dup_cells = 0
    shape = 0x811C9DC5
    for key, _, _, n in order:
        for byte in struct.pack("<I", key) + bytes([n & 255]):
            shape = ((shape ^ byte) * 0x01000193) & 0xFFFFFFFF
    for _, a, b, n in order:
        if n > 255:
            raise ValueError(f"cell {a}-{b} has {n} slots; one byte per slot holds 0..255")
        first = {}
        canon = []
        for slot in range(n):
            digest = digests.get((a, b, slot))
            canon.append(slot if digest is None else first.setdefault(digest, slot))
        if canon != list(range(n)):
            dup_cells += 1
        out_bytes.extend(canon)
    out = Path(out_path)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_bytes(DUPES_MAGIC + struct.pack("<III", len(out_bytes), len(order), shape)
                    + bytes(out_bytes))
    tmp.replace(out)
    return dup_cells


def write_refresh_copy(bin_path: Path, txt_path: Path) -> int:
    """static/art-dupes.txt: the .bin gzipped and base64-encoded (text, so
    the iOS live-update can ship it). Returns its size in bytes."""
    data = base64.b64encode(gzip.compress(Path(bin_path).read_bytes(), 9, mtime=0))
    out = Path(txt_path)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_bytes(data + b"\n")
    tmp.replace(out)
    return len(data) + 1
