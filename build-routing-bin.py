#!/usr/bin/env python3
"""Post-process a region directory's walk.bin into a routing.bin.

routing.bin is a search-only subset of walk.bin: just the data Dijkstra
actually reads (node coords + pre-built CSR adjacency + per-adjacency
weights), in a layout that supports zero-copy loading at runtime —
the JS side creates typed-array views over the file bytes and starts
Dijkstra immediately, no parsing pass needed.

walk.bin is NOT modified. routing.bin sits alongside it. The runtime
loader will prefer routing.bin when present (fast path) and fall back
to walk.bin when not (legacy path, current behavior).

Usage:
    python3 build-routing-bin.py regions/region-0361/walk.bin
    python3 build-routing-bin.py regions/*/walk.bin
    python3 build-routing-bin.py regions/region-0361/    # directory form

For each input walk.bin, writes routing.bin in the same directory.
Skips regions where routing.bin already exists unless --force is set.

────────────────────────────────────────────────────────────────────
routing.bin v2 layout (all little-endian, 4-byte aligned):

  off  size           field
  ─────────────────────────────────────────────────────────
  0    4              magic = 'ROUT'
  4    4              version = 2
  8    4              nodeCount  (N)
  12   4              edgeCount  (E)        — undirected, original count
  16   4              adjCount   = 2 * E    — directed adjacency entries
  20   4              longWeightCount (L)   — count of edges > 254m
  24   4              reserved
  28   4              reserved
  32                  ── data sections begin ──

  off0      4 * N           nodeLng (Float32)
  off0+4N   4 * N           nodeLat (Float32)
  off1      4 * (N+1)       adjStart (Uint32) — CSR row offsets
  off2      4 * adjCount    adjPacked (Uint32) — neighbor entry, packed:
                              bits 0..23  = target node index (24 bits → 16M max)
                              bits 24..31 = weight tier byte:
                                0..254 → weight in meters (read directly)
                                255    → look up in long-weight side table
  off3      4 * L           longWeightAdjIdx (Uint32) — adjPacked indices
                              that have weight tier 255, sorted ascending.
                              Used by JS via binary search at runtime:
                              find(L, adjIdx) → position → longWeight[pos].
  off4      4 * L           longWeight (Float32) — full weights for those
                              entries.

  Notes on the design trade:
    - 24-bit target supports up to 16M nodes per region. Largest North
      America partition leaf is ~600k nodes. Plenty of headroom.
    - 8-bit weight covers 0-254m. Walk edges are typically <100m, so
      ~95% fit directly; the rare long edge (rural roads, motorway
      footpaths) uses the side table.
    - Float32 weights in the side table preserve full precision for
      the long-edge case.
    - adjStart stays Uint32 — we need random access by node index
      for Dijkstra neighbor enumeration. Could be packed (Uint16
      with periodic Uint32 bases) for ~1 MB savings but adds CPU
      to every neighbor lookup.

  RAM impact per region (~412k nodes / 550k edges, region-0361):
    v1: 13.6 MB (4.4 adjTo + 4.4 adjWeight + 3.2 nodes + 1.6 adjStart)
    v2: ~9.6 MB (4.4 adjPacked + 0.4 long table + 3.2 nodes + 1.6 adjStart)
"""
import argparse
import gzip
import struct
import sys
from pathlib import Path


# ── walk.bin v3 reader (mirrors viewWalkRegion in static/index.html) ───

def _read_walk_bin(path: Path) -> dict:
    """Parse walk.bin into a dict with the fields needed for routing.
    Handles gzip transparently. Returns nodeLng/nodeLat/edgeFrom/edgeTo/
    edgeWeight (decompressed). Skips name + shape data — we don't need
    them for routing.bin."""
    data = path.read_bytes()
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    if data[:4] != b'WALK':
        raise ValueError(f'{path}: bad magic {data[:4]!r}')
    version = struct.unpack_from('<I', data, 4)[0]
    if version != 3:
        raise ValueError(f'{path}: unsupported walk.bin version {version}')

    N = struct.unpack_from('<I', data, 8)[0]
    E = struct.unpack_from('<I', data, 12)[0]
    u8_end = struct.unpack_from('<I', data, 28)[0]
    u16_end = struct.unpack_from('<I', data, 32)[0]

    def align4(x: int) -> int:
        return (x + 3) & ~3

    nodes_start = 48
    # nodeIds (Float64) skipped — only nodeLng/Lat needed.
    node_lng = struct.unpack_from(f'<{N}f', data, nodes_start + 8 * N)
    node_lat = struct.unpack_from(f'<{N}f', data, nodes_start + 12 * N)

    edges_start = nodes_start + 16 * N
    edge_from = struct.unpack_from(f'<{E}I', data, edges_start)
    edge_to   = struct.unpack_from(f'<{E}I', data, edges_start + 4 * E)

    # Decompress weights (variable width on disk: Uint8 then Uint16 then
    # Float32, sentinel offsets at u8_end / u16_end).
    weight_u8_off  = edges_start + 8 * E
    weight_u16_cnt = u16_end - u8_end
    weight_f32_cnt = E - u16_end
    weight_u16_off = weight_u8_off  + align4(u8_end)
    weight_f32_off = weight_u16_off + align4(2 * weight_u16_cnt)

    edge_weight = [0.0] * E
    if u8_end > 0:
        u8_vals = struct.unpack_from(f'<{u8_end}B', data, weight_u8_off)
        for i, v in enumerate(u8_vals):
            edge_weight[i] = float(v)
    if weight_u16_cnt > 0:
        u16_vals = struct.unpack_from(f'<{weight_u16_cnt}H', data, weight_u16_off)
        for i, v in enumerate(u16_vals):
            edge_weight[u8_end + i] = float(v)
    if weight_f32_cnt > 0:
        f32_vals = struct.unpack_from(f'<{weight_f32_cnt}f', data, weight_f32_off)
        for i, v in enumerate(f32_vals):
            edge_weight[u16_end + i] = float(v)

    return {
        'N': N, 'E': E,
        'nodeLng': node_lng,
        'nodeLat': node_lat,
        'edgeFrom': edge_from,
        'edgeTo': edge_to,
        'edgeWeight': edge_weight,
    }


# ── CSR adjacency build ─────────────────────────────────────────────

# Tier sentinel: weight byte 0xFF means "real weight is in side table."
LONG_WEIGHT_TIER = 0xFF
SHORT_WEIGHT_MAX = LONG_WEIGHT_TIER - 1   # 254 meters fits in one byte

# 24-bit target index limit. Any region with more nodes can't use v2.
TARGET_MAX = (1 << 24) - 1


def _build_csr_packed(N: int, E: int, edge_from, edge_to, edge_weight):
    """Build undirected adjacency CSR with packed Uint32 entries.

    Returns (adjStart, adjPacked, longWeightAdjIdx, longWeight) where:
      - adjStart[i] = first adjPacked index for node i
      - adjPacked[k] = (target << 8) | weight_tier
      - longWeightAdjIdx[m] = adjPacked index for the m-th edge whose
        weight exceeded SHORT_WEIGHT_MAX. Sorted ascending so the JS
        side can binary-search by adj index.
      - longWeight[m] = Float32 weight for that entry.
    """
    if N > TARGET_MAX:
        raise ValueError(
            f'node count {N} exceeds 24-bit target limit '
            f'({TARGET_MAX}); raise routing.bin format version to handle'
        )
    counts = [0] * N
    for i in range(E):
        counts[edge_from[i]] += 1
        counts[edge_to[i]]   += 1
    adj_start = [0] * (N + 1)
    total = 0
    for i in range(N):
        adj_start[i] = total
        total += counts[i]
    adj_start[N] = total

    adj_packed = [0] * total
    long_idx = []
    long_w   = []
    cursor = [0] * N

    def _pack_entry(adj_pos: int, target: int, weight: float) -> int:
        # Round to nearest meter for the short-tier check. Values that
        # round to >=255 use the long table; we keep the original
        # Float32 weight there so we don't lose precision.
        wr = round(weight)
        if 0 <= wr <= SHORT_WEIGHT_MAX:
            return (target << 8) | wr
        long_idx.append(adj_pos)
        long_w.append(float(weight))
        return (target << 8) | LONG_WEIGHT_TIER

    for i in range(E):
        u = edge_from[i]
        v = edge_to[i]
        w = edge_weight[i]
        # Edge u → v.
        pu = adj_start[u] + cursor[u]
        adj_packed[pu] = _pack_entry(pu, v, w)
        cursor[u] += 1
        # Edge v → u (same weight, separate adj entry).
        pv = adj_start[v] + cursor[v]
        adj_packed[pv] = _pack_entry(pv, u, w)
        cursor[v] += 1

    # long_idx is already in ascending order because we appended in
    # adj_pos order. Verify cheaply:
    for j in range(1, len(long_idx)):
        if long_idx[j] <= long_idx[j - 1]:
            # Unexpected — the loop above guarantees monotonic appends.
            # Sort defensively so JS binary search stays correct.
            paired = sorted(zip(long_idx, long_w))
            long_idx = [p[0] for p in paired]
            long_w   = [p[1] for p in paired]
            break

    return adj_start, adj_packed, long_idx, long_w


# ── routing.bin writer ──────────────────────────────────────────────

ROUTING_MAGIC   = b'ROUT'
ROUTING_VERSION = 2
ROUTING_HEADER  = 32  # bytes


def write_routing_bin(out_path: Path, parsed: dict) -> dict:
    """Write a routing.bin v2 from parsed walk-graph data. Returns a
    stats dict with sizes + long-edge count."""
    N = parsed['N']
    E = parsed['E']
    adj_start, adj_packed, long_idx, long_w = _build_csr_packed(
        N, E, parsed['edgeFrom'], parsed['edgeTo'], parsed['edgeWeight'])
    adj_count = len(adj_packed)
    L = len(long_idx)
    assert adj_count == 2 * E
    assert len(long_w) == L

    buf = bytearray()
    # Header (32 bytes, padded reserved).
    buf += ROUTING_MAGIC
    buf += struct.pack('<I', ROUTING_VERSION)
    buf += struct.pack('<I', N)
    buf += struct.pack('<I', E)
    buf += struct.pack('<I', adj_count)
    buf += struct.pack('<I', L)
    buf += struct.pack('<II', 0, 0)  # reserved
    assert len(buf) == ROUTING_HEADER

    # nodeLng / nodeLat (Float32 each)
    buf += struct.pack(f'<{N}f', *parsed['nodeLng'])
    buf += struct.pack(f'<{N}f', *parsed['nodeLat'])
    # adjStart (N+1, Uint32)
    buf += struct.pack(f'<{N + 1}I', *adj_start)
    # adjPacked (adj_count, Uint32, packed)
    buf += struct.pack(f'<{adj_count}I', *adj_packed)
    # longWeightAdjIdx (L, Uint32)
    if L:
        buf += struct.pack(f'<{L}I', *long_idx)
        buf += struct.pack(f'<{L}f', *long_w)

    out_path.write_bytes(buf)
    return {
        'bytes': len(buf),
        'N': N, 'E': E,
        'adjCount': adj_count,
        'longWeightCount': L,
        'longWeightPct': (L / adj_count * 100.0) if adj_count else 0.0,
    }


# ── CLI ─────────────────────────────────────────────────────────────

def _resolve_inputs(argv_paths):
    """Accept either explicit walk.bin paths or region directories
    (in which case we look for walk.bin inside). Returns list of
    walk.bin Path objects."""
    out = []
    for a in argv_paths:
        p = Path(a)
        if p.is_dir():
            wb = p / 'walk.bin'
            if wb.is_file():
                out.append(wb)
            else:
                print(f'skip: {p} (no walk.bin inside)', file=sys.stderr)
        elif p.is_file():
            out.append(p)
        else:
            print(f'skip: {p} (not found)', file=sys.stderr)
    return out


def fmt_mb(n: int) -> str:
    return f'{n / 1048576:.2f} MB'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='+',
                    help='walk.bin file(s) or region director(ies)')
    ap.add_argument('--force', action='store_true',
                    help='overwrite existing routing.bin')
    args = ap.parse_args()

    walk_paths = _resolve_inputs(args.paths)
    if not walk_paths:
        print('no walk.bin inputs found', file=sys.stderr)
        sys.exit(2)

    total_in = 0
    total_out = 0
    total_long = 0
    total_adj = 0
    written = 0
    skipped = 0
    for wb in walk_paths:
        out_path = wb.parent / 'routing.bin'
        if out_path.exists() and not args.force:
            skipped += 1
            continue
        try:
            parsed = _read_walk_bin(wb)
        except Exception as exc:
            print(f'parse failed: {wb} ({exc})', file=sys.stderr)
            continue
        stats = write_routing_bin(out_path, parsed)
        in_size = wb.stat().st_size
        total_in += in_size
        total_out += stats['bytes']
        total_long += stats['longWeightCount']
        total_adj += stats['adjCount']
        written += 1
        print(
            f'  {wb.parent.name}  '
            f'walk.bin={fmt_mb(in_size):<10}  '
            f'routing.bin={fmt_mb(stats["bytes"]):<10}  '
            f'N={stats["N"]:>7} E={stats["E"]:>7}  '
            f'long={stats["longWeightCount"]:>6} ({stats["longWeightPct"]:.1f}%)'
        )

    print()
    print(f'wrote {written} routing.bin file(s), '
          f'skipped {skipped} (already exist; use --force to overwrite)')
    if written:
        print(f'total walk.bin bytes (gzipped on disk): {fmt_mb(total_in)}')
        print(f'total routing.bin bytes (uncompressed): {fmt_mb(total_out)}')
        if total_adj:
            print(f'long-weight escapes: {total_long}/{total_adj} '
                  f'({total_long / total_adj * 100:.2f}% of adjacencies)')


if __name__ == '__main__':
    main()
