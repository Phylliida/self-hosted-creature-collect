#!/usr/bin/env python3
"""Post-process region directories to write boundaries.bin per region.

A "boundary node" is an OSM node whose ID appears in 2+ regions —
i.e., it sits on (or near) a partition boundary and was included by
the build-walk-graph pass for each region that contains its bbox.

At runtime, after loading multiple regions' routing.bin, the JS side
reads each region's boundaries.bin to identify which internal node
indices are boundary nodes. It then builds a cross-region peer index
(osmId → list of globalIds) so Dijkstra can cross region boundaries
via zero-cost virtual edges, avoiding the merge step entirely.

boundaries.bin is self-contained per region — it lists THIS region's
boundary nodes (internalIdx + osmId pairs). It doesn't reference
other regions by name, which means:
  - File contents are stable regardless of which other regions a
    user has downloaded.
  - Adding new regions later doesn't invalidate existing boundaries.bin
    files (though it may introduce new boundary nodes for them).
  - Runtime matching is a simple "find OSM IDs that appear in 2+
    loaded regions' boundary lists."

Usage:
    python3 build-boundaries.py regions/region-0361/ regions/region-0530/
    python3 build-boundaries.py regions/*/walk.bin
    python3 build-boundaries.py regions/                # all subdirs

Pass --force to overwrite existing boundaries.bin files.

────────────────────────────────────────────────────────────────────
boundaries.bin v1 layout (all little-endian):

  off  size            field
  ─────────────────────────────────────────────────────────
  0    4               magic = 'BOND'
  4    4               version = 1
  8    4               count (C) — boundary node count in this region
  12   4               reserved (pad header to 16 bytes for alignment)
  16   8 * C           osmIds (Float64), 8-byte aligned
  16+8C 4 * C          internalIdxs (Uint32), sorted ascending

  - osmIds are Float64 (matching walk.bin's nodeIds). Stored first so
    the array starts 8-aligned without padding.
  - internalIdxs are sorted ascending so the JS side can binary-search
    by internalIdx during Dijkstra ("is this popped node a boundary?")
  - osmIds[i] corresponds to internalIdxs[i] — parallel SoA layout.

  Typical size: ~1k-5k boundary nodes per region × 12 bytes = 12-60 KB
  per region. Tiny vs routing.bin (~10 MB).

Memory note:
  This script holds ALL regions' OSM IDs in memory simultaneously to
  find duplicates across regions. For ~4 regions × ~500k nodes = 2M
  IDs — fits comfortably. For 600+ regions (full NA build) it'd need
  ~50 GB of RAM, in which case rewrite the dup-detection pass to use
  sorted external storage. Not a concern at the current scale.
"""
import argparse
import gzip
import struct
import sys
from collections import defaultdict
from pathlib import Path

# numpy is optional but DRAMATICALLY faster at scale (10x+ speedup for
# the cross-region OSM-id dedup pass when running over hundreds of
# regions). When unavailable, fall back to the pure-Python dict path
# which is fine for a handful of regions but bloats to many GB of
# dict overhead at full-NA scale.
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


BOND_MAGIC   = b'BOND'
BOND_VERSION = 1
BOND_HEADER  = 16


def _read_walk_node_ids(path: Path):
    """Extract just the nodeIds (Float64) section from walk.bin.
    Skips everything else — name, shape, edge data — to keep memory
    consumption proportional to NODE count, not full file size."""
    data = path.read_bytes()
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    if data[:4] != b'WALK':
        raise ValueError(f'{path}: bad magic {data[:4]!r}')
    version = struct.unpack_from('<I', data, 4)[0]
    if version != 3:
        raise ValueError(f'{path}: unsupported walk.bin version {version}')
    N = struct.unpack_from('<I', data, 8)[0]
    # nodeIds (Float64) starts at offset 48 in walk.bin v3 layout.
    node_ids = struct.unpack_from(f'<{N}d', data, 48)
    return node_ids


def _write_boundaries_bin(out_path: Path, boundary_entries):
    """boundary_entries: list of (internalIdx, osmId), already sorted
    by internalIdx ascending."""
    C = len(boundary_entries)
    buf = bytearray()
    buf += BOND_MAGIC
    buf += struct.pack('<I', BOND_VERSION)
    buf += struct.pack('<I', C)
    buf += struct.pack('<I', 0)   # reserved
    assert len(buf) == BOND_HEADER
    # osmIds first (Float64 → 8-byte aligned naturally after 16-byte header).
    for _, oid in boundary_entries:
        buf += struct.pack('<d', oid)
    # internalIdxs second (Uint32).
    for idx, _ in boundary_entries:
        buf += struct.pack('<I', idx)
    out_path.write_bytes(buf)
    return len(buf)


def _resolve_inputs(argv_paths):
    """Accept walk.bin paths OR region directories OR a parent dir
    containing region subdirs. Returns list of walk.bin Paths."""
    out = []
    for a in argv_paths:
        p = Path(a)
        if p.is_dir():
            # Direct region dir?
            wb = p / 'walk.bin'
            if wb.is_file():
                out.append(wb)
                continue
            # Parent dir containing region subdirs?
            for sub in sorted(p.iterdir()):
                sub_wb = sub / 'walk.bin'
                if sub.is_dir() and sub_wb.is_file():
                    out.append(sub_wb)
        elif p.is_file():
            out.append(p)
        else:
            print(f'skip: {p} (not found)', file=sys.stderr)
    return out


def fmt_kb(n: int) -> str:
    if n < 1024:
        return f'{n} B'
    if n < 1024 * 1024:
        return f'{n / 1024:.1f} KB'
    return f'{n / 1048576:.2f} MB'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='+',
                    help='walk.bin file(s), region director(ies), or a parent dir')
    ap.add_argument('--force', action='store_true',
                    help='overwrite existing boundaries.bin files')
    args = ap.parse_args()

    walk_paths = _resolve_inputs(args.paths)
    if not walk_paths:
        print('no walk.bin inputs found', file=sys.stderr)
        sys.exit(2)

    # Pass 1: load every region's nodeIds and identify which IDs
    # appear in 2+ regions. The numpy path stacks all IDs into one
    # int64 array, sorts in place, then scans for adjacent duplicates
    # — much faster (and lower-memory) than a Python dict at scale.
    # Pure-Python path is dict-based and fine for a handful of regions.
    if HAS_NUMPY:
        print(f'pass 1 (numpy): scanning {len(walk_paths)} region(s) for shared OSM IDs…')
    else:
        print(f'pass 1 (pure-py): scanning {len(walk_paths)} region(s) for shared OSM IDs…')
        print(f'  hint: install numpy for substantially faster + lower-memory builds')
    region_node_ids = []   # parallel to walk_paths
    total_nodes = 0
    for wb in walk_paths:
        try:
            ids = _read_walk_node_ids(wb)
        except Exception as exc:
            print(f'  skip: {wb} ({exc})', file=sys.stderr)
            region_node_ids.append(None)
            continue
        if HAS_NUMPY:
            # OSM node IDs are integer-valued (stored as Float64 in
            # walk.bin); cast to int64 so dedup uses integer compare
            # and the per-region array halves in size from the tuple
            # version Python would otherwise build.
            region_node_ids.append(np.array(ids, dtype=np.int64))
        else:
            region_node_ids.append(ids)
        total_nodes += len(ids)

    if HAS_NUMPY:
        # Stack all regions' IDs, sort, then walk to find duplicates.
        non_empty = [a for a in region_node_ids if a is not None]
        combined = np.concatenate(non_empty)
        del non_empty
        print(f'  sorting {len(combined)} ids…')
        combined.sort()
        # An ID appears in ≥2 regions iff its value occurs ≥2 times
        # in the sorted array. dup_mask[i] = combined[i] == combined[i+1]
        # → True at the LEFT side of any adjacent-equal pair.
        dup_mask = combined[:-1] == combined[1:]  # length N-1
        # Mark BOTH sides of every duplicate-pair, not just the first.
        dup_any = np.zeros(len(combined), dtype=bool)
        dup_any[:-1] |= dup_mask   # left side
        dup_any[1:]  |= dup_mask   # right side
        shared_arr = combined[dup_any]
        # Unique-ify (a run of K duplicates yields K entries; collapse).
        shared_arr = np.unique(shared_arr)
        del combined, dup_mask, dup_any
        # Keep both representations available: shared_np for vectorized
        # np.isin in pass 2 (fast bulk check per region); shared_py for
        # the pure-Python fallback path which expects a `in shared` op.
        shared_np = shared_arr
        shared = None  # only the python-set path uses this
        del shared_arr
    else:
        id_counts = defaultdict(int)
        for ids in region_node_ids:
            if ids is None: continue
            for oid in ids:
                id_counts[oid] += 1
        shared = {oid for oid, cnt in id_counts.items() if cnt >= 2}
        id_counts.clear()
    shared_count = (len(shared_np) if HAS_NUMPY else len(shared))
    print(f'  scanned {total_nodes} node IDs across {len(walk_paths)} regions')
    print(f'  found {shared_count} OSM IDs shared by 2+ regions')

    # Pass 2: per region, find its boundary nodes and write the file.
    print(f'pass 2: writing boundaries.bin per region…')
    written = 0
    skipped = 0
    total_bytes = 0
    total_boundary_nodes = 0
    for wb, ids in zip(walk_paths, region_node_ids):
        if ids is None:
            continue
        out_path = wb.parent / 'boundaries.bin'
        if out_path.exists() and not args.force:
            skipped += 1
            continue
        if HAS_NUMPY:
            # Vectorized membership test via np.isin — orders of
            # magnitude faster than Python per-element iteration when
            # ids has hundreds of thousands of entries.
            mask = np.isin(ids, shared_np)
            boundary_internals = np.where(mask)[0]
            boundary_osm_ids = ids[mask]
            entries = list(zip(
                (int(x) for x in boundary_internals.tolist()),
                (float(x) for x in boundary_osm_ids.tolist()),
            ))
        else:
            entries = []
            for i, oid in enumerate(ids):
                if oid in shared:
                    entries.append((i, oid))
        # already sorted since we scan internalIdx in ascending order
        size = _write_boundaries_bin(out_path, entries)
        total_bytes += size
        total_boundary_nodes += len(entries)
        written += 1
        pct = (len(entries) / len(ids) * 100.0) if len(ids) else 0.0
        print(f'  {wb.parent.name}: {len(entries):>6} boundary nodes '
              f'({pct:.1f}% of {len(ids)})  {fmt_kb(size)}')

    print()
    print(f'wrote {written} boundaries.bin file(s), skipped {skipped} '
          f'(use --force to overwrite)')
    if written:
        print(f'total boundary nodes: {total_boundary_nodes}')
        print(f'total boundaries.bin bytes: {fmt_kb(total_bytes)}')


if __name__ == '__main__':
    main()
