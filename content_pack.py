#!/usr/bin/env python3
"""Writer/reader for the creature content pack format (pack.bin).

The pack is the TRANSPORT for the app's creature content — installing
it reproduces today's bundled-data state exactly (same logical paths,
same bytes, same IDB/localStorage equivalents via the existing import
paths). It is NOT a new data model.

Layout (little-endian):

    offset 0    magic b'CCPACK01' (8 bytes)
    offset 8    u32 format version (= FORMAT_VERSION)
    offset 12   u64 TOC byte length
    offset 20   TOC (UTF-8 JSON, see below)
    then        blob area — every entry's raw bytes concatenated,
                each entry starting at an 8-byte-aligned offset

TOC JSON:

    { "id": ..., "format": 1, "contentVersion": <utc ISO>,
      "entries": { "<logical/path>": {"offset": N, "length": M,
                                      "sha256": "<hex>"}, ... } }

Read path (client): fetch/seek the header + TOC once, then Blob.slice /
seek per asset — O(1), zero processing, exactly what's needed.
"""

import hashlib
import json
import struct
import time
from pathlib import Path

MAGIC = b"CCPACK01"
FORMAT_VERSION = 1
HEADER_BYTES = 20  # magic(8) + version(u32) + tocLen(u64)
ALIGN = 8
_CHUNK = 1024 * 1024  # 1 MiB streaming chunks — never hold big files in RAM


def _sha256_file(path, hasher=None):
    h = hasher or hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(_CHUNK)
            if not b:
                break
            h.update(b)
    return h


def write_pack(entries, out_bin, manifest, pack_id="creature-fusion",
               content_version=None):
    """Write pack.bin + pack.json.

    entries: list of (logical_path, src_path) — logical paths use forward
    slashes and mirror the bundled-data tree exactly.
    out_bin: Path for the .bin; manifest: Path for the human manifest.
    content_version: override the build timestamp stamped into the TOC —
    used when deriving a variant pack (e.g. the native no-sprites build)
    from an existing pack so both manifests describe the same content.
    Returns the TOC dict.
    """
    out_bin = Path(out_bin)
    manifest = Path(manifest)

    # Deduplicate + sort for deterministic layout.
    seen = {}
    for logical, src in entries:
        logical = logical.replace("\\", "/").lstrip("/")
        src = Path(src)
        if not src.is_file():
            raise FileNotFoundError(f"pack source missing: {src}")
        seen[logical] = src
    logicals = sorted(seen)

    # Hash every entry up front (streaming) and lay out offsets.
    toc_entries = {}
    for logical in logicals:
        src = seen[logical]
        toc_entries[logical] = {
            "length": src.stat().st_size,
            "sha256": _sha256_file(src).hexdigest(),
        }

    toc = {
        "id": pack_id,
        "format": FORMAT_VERSION,
        "contentVersion": (content_version
                           or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        "entries": toc_entries,
    }
    # Offsets are relative to the start of the FILE (absolute), computed
    # after the TOC length is known. TOC JSON contains offsets, so fix
    # point: build once with placeholder offsets to learn the length,
    # then rebuild with real ones (length is stable — offsets are
    # fixed-width decimal? No — recompute until stable, max 3 passes).
    toc_bytes = b""
    for _ in range(3):
        blob_start = HEADER_BYTES + len(toc_bytes)
        offset = blob_start
        for logical in logicals:
            pad = (-offset) % ALIGN
            offset += pad
            toc_entries[logical]["offset"] = offset
            offset += toc_entries[logical]["length"]
        new_toc_bytes = json.dumps(
            toc, separators=(",", ":"), sort_keys=False).encode("utf-8")
        if len(new_toc_bytes) == len(toc_bytes):
            toc_bytes = new_toc_bytes
            break
        toc_bytes = new_toc_bytes
    else:
        raise RuntimeError("TOC length did not stabilize")

    total_bytes = offset
    out_bin.parent.mkdir(parents=True, exist_ok=True)
    whole = hashlib.sha256()
    with open(out_bin, "wb") as out:
        out.write(MAGIC)
        out.write(struct.pack("<I", FORMAT_VERSION))
        out.write(struct.pack("<Q", len(toc_bytes)))
        out.write(toc_bytes)
        whole.update(MAGIC)
        whole.update(struct.pack("<I", FORMAT_VERSION))
        whole.update(struct.pack("<Q", len(toc_bytes)))
        whole.update(toc_bytes)
        cursor = HEADER_BYTES + len(toc_bytes)
        for logical in logicals:
            target = toc_entries[logical]["offset"]
            if target < cursor:
                raise RuntimeError(f"layout overlap at {logical}")
            pad = target - cursor
            if pad:
                out.write(b"\0" * pad)
                whole.update(b"\0" * pad)
                cursor += pad
            with open(seen[logical], "rb") as f:
                while True:
                    b = f.read(_CHUNK)
                    if not b:
                        break
                    out.write(b)
                    whole.update(b)
                    cursor += len(b)

    man = {
        "id": pack_id,
        "format": FORMAT_VERSION,
        "contentVersion": toc["contentVersion"],
        "file": out_bin.name,
        "totalBytes": total_bytes,
        "entryCount": len(logicals),
        "sha256": whole.hexdigest(),
        "toc": toc,
    }
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(man, indent=1), encoding="utf-8")
    return toc


def read_toc(bin_path):
    """Read just the header + TOC of a pack.bin (seeks, never loads blobs)."""
    with open(bin_path, "rb") as f:
        header = f.read(HEADER_BYTES)
        if len(header) != HEADER_BYTES or header[:8] != MAGIC:
            raise ValueError("not a content pack (bad magic)")
        (version,) = struct.unpack("<I", header[8:12])
        if version != FORMAT_VERSION:
            raise ValueError(f"unsupported pack format version {version}")
        (toc_len,) = struct.unpack("<Q", header[12:20])
        toc = json.loads(f.read(toc_len).decode("utf-8"))
    return toc


def filter_pack(bin_in, out_bin, manifest, drop_prefixes=()):
    """Derive a variant pack from an existing one by dropping entries.

    Entries whose logical path starts with any of drop_prefixes are left
    out; the rest are copied byte-for-byte (per-entry sha256 re-verified
    on read). The derived pack keeps the source pack's id and
    contentVersion — it is the same content in a smaller transport, so a
    client holding the full pack is not 'out of date' against the
    variant manifest.
    """
    import tempfile
    toc = read_toc(bin_in)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        entries = []
        for logical in sorted(toc["entries"]):
            if any(logical.startswith(p) for p in drop_prefixes):
                continue
            dst = tmpdir / logical
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(read_entry(bin_in, toc, logical))
            entries.append((logical, dst))
        return write_pack(entries, out_bin, manifest,
                          pack_id=toc["id"],
                          content_version=toc["contentVersion"])


def replace_entries(bin_in, out_bin, manifest, overrides,
                    content_version=None):
    """Rewrite a pack with the given entries replaced by new bytes.

    overrides: {logical_path: bytes}. All other entries are copied
    byte-for-byte (per-entry sha256 re-verified on read). Pass an
    explicit content_version when the change is a real content update
    that installed clients should pick up; omitting it preserves the
    source pack's version (transport-only change).
    """
    import tempfile
    toc = read_toc(bin_in)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        entries = []
        for logical in sorted(toc["entries"]):
            dst = tmpdir / logical
            dst.parent.mkdir(parents=True, exist_ok=True)
            if logical in overrides:
                dst.write_bytes(overrides[logical])
            else:
                dst.write_bytes(read_entry(bin_in, toc, logical))
            entries.append((logical, dst))
        return write_pack(entries, out_bin, manifest,
                          pack_id=toc["id"],
                          content_version=content_version
                          or toc["contentVersion"])


def read_entry(bin_path, toc, logical):
    """Slice one entry's raw bytes out of a pack.bin."""
    e = toc["entries"][logical]
    with open(bin_path, "rb") as f:
        f.seek(e["offset"])
        data = f.read(e["length"])
    if len(data) != e["length"]:
        raise ValueError(f"truncated entry {logical}")
    if hashlib.sha256(data).hexdigest() != e["sha256"]:
        raise ValueError(f"hash mismatch on entry {logical}")
    return data
