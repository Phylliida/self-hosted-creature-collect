#!/usr/bin/env python3
"""Convert shiny-palettes.json → shiny-palettes.bin.

The JSON is human-readable but verbose (~1.8 MB). The binary form
quantizes each (φ, ΔL, κ) triple into 4 bytes — well under
perceptual thresholds — and gets the bundle down to ~275 KB without
gzip, ~150 KB gzipped. Easy to load in JS via DataView.

Layout (all little-endian):

  off  size   field
  ──── ────── ────────────────────────────────────────────────
  0    4      magic 'SHIN'
  4    4      version (uint32 = 2)
  8    4      entry count (uint32)
  12   4      reserved (zero)
  16   …      entries

  Per entry (52 bytes):
    rootA: uint16                    # family-root species id A (PIF id, up to 503)
    rootB: uint16                    # family-root species id B
    triples[12]: each 4 bytes
      phi:    int16  → val / 32767 * π   in radians, range ±π
      deltaL: int8   → val / 127 * 0.20  in OKLAB L, range ±0.20
      kappa:  uint8  → 0.5 + val / 255   in [0.5, 1.5]

  Version history:
    v1 (2026-05) — rootA/rootB were uint8 (gen-1 only, max id 150)
    v2 (2026-06) — rootA/rootB are uint16 (now covers PIF ids up to 503)

Entries are written sorted by (rootA, rootB) so a JS reader can
binary-search if it wants, though a Map<rootA*256+rootB, triples>
load is also fine for the ~5600-entry set.

Usage:
    python3 shiny-palettes-to-bin.py
        # reads data/BundledData/shiny-palettes.json
        # writes data/BundledData/shiny-palettes.bin
    python3 shiny-palettes-to-bin.py --verify
        # also round-trips the bin back to floats and compares
"""

import argparse
import json
import math
import struct
import sys
from pathlib import Path


MAGIC = b'SHIN'
VERSION = 2
HEADER_BYTES = 16
ENTRY_BYTES = 4 + 12 * 4  # 52 (v2: rootA/rootB became uint16)

DELTA_L_RANGE = 0.20
KAPPA_MIN, KAPPA_MAX = 0.5, 1.5
KAPPA_SPAN = KAPPA_MAX - KAPPA_MIN  # 1.0


def encode_triple(phi, dl, kp):
    """Pack one (phi, deltaL, kappa) triple into 4 bytes."""
    phi_q = max(-32767, min(32767, round(phi / math.pi * 32767)))
    dl_q = max(-127, min(127, round(dl / DELTA_L_RANGE * 127)))
    # Clamp kappa to its bake range before quantization — values
    # outside [0.5, 1.5] shouldn't appear from the sampler but defend
    # against floating-point drift past the boundary.
    kp_clamped = max(KAPPA_MIN, min(KAPPA_MAX, kp))
    kp_q = round((kp_clamped - KAPPA_MIN) / KAPPA_SPAN * 255)
    return struct.pack('<hbB', phi_q, dl_q, kp_q)


def decode_triple(buf, off):
    """Round-trip a 4-byte triple back to floats."""
    phi_q, dl_q, kp_q = struct.unpack_from('<hbB', buf, off)
    return (
        phi_q / 32767 * math.pi,
        dl_q / 127 * DELTA_L_RANGE,
        KAPPA_MIN + kp_q / 255 * KAPPA_SPAN,
    )


def pack(data, out_path):
    """Serialize the JSON shape `{"rootA-rootB": [[phi, dl, kp]×12], ...}`
    to the binary layout. Sorts entries by (rootA, rootB) so a JS
    reader can use binary search if it wants."""
    keys = []
    for k in data.keys():
        a_str, b_str = k.split('-')
        keys.append((int(a_str), int(b_str), k))
    keys.sort()

    buf = bytearray()
    buf += MAGIC
    buf += struct.pack('<III', VERSION, len(keys), 0)
    for (a, b, raw_key) in keys:
        if a > 0xFFFF or b > 0xFFFF:
            raise ValueError(f'species id out of u16 range: {raw_key}')
        triples = data[raw_key]
        if len(triples) != 12:
            raise ValueError(
                f'expected 12 triples for {raw_key}, got {len(triples)}')
        buf += struct.pack('<HH', a, b)
        for (phi, dl, kp) in triples:
            buf += encode_triple(phi, dl, kp)

    out_path.write_bytes(buf)
    return len(buf), len(keys)


def verify(json_data, bin_path):
    """Round-trip every triple through encode → decode and report the
    maximum absolute deviation per axis. Confirms the quantization is
    below perceptual thresholds."""
    buf = bin_path.read_bytes()
    if buf[:4] != MAGIC:
        raise ValueError(f'bad magic in {bin_path}')
    version, count, _reserved = struct.unpack_from('<III', buf, 4)
    print(f'  version={version}  entries={count}')

    max_dphi = 0.0
    max_ddl = 0.0
    max_dk = 0.0
    off = HEADER_BYTES
    for _ in range(count):
        a, b = struct.unpack_from('<HH', buf, off)
        off += 4
        key = f'{a}-{b}'
        orig = json_data.get(key)
        if not orig:
            raise ValueError(f'entry {key} in bin but missing from JSON')
        for j in range(12):
            phi_d, dl_d, kp_d = decode_triple(buf, off + j * 4)
            orig_phi, orig_dl, orig_kp = orig[j]
            max_dphi = max(max_dphi, abs(phi_d - orig_phi))
            max_ddl = max(max_ddl, abs(dl_d - orig_dl))
            max_dk = max(max_dk, abs(kp_d - orig_kp))
        off += 12 * 4
    print(f'  max round-trip Δφ:  {math.degrees(max_dphi):.4f}°')
    print(f'  max round-trip ΔdL: {max_ddl:.6f}  (perceptual JND ~0.01)')
    print(f'  max round-trip Δκ:  {max_dk:.6f}')


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        '--input', type=Path,
        default=Path('data/BundledData/shiny-palettes.json'),
        help='Input JSON (default: data/BundledData/shiny-palettes.json)')
    ap.add_argument(
        '--output', type=Path,
        default=Path('data/BundledData/shiny-palettes.bin'),
        help='Output binary (default: data/BundledData/shiny-palettes.bin)')
    ap.add_argument('--verify', action='store_true',
                    help='Round-trip the bin back to floats and report '
                         'max quantization deviation per axis.')
    args = ap.parse_args()

    if not args.input.is_file():
        print(f'input not found: {args.input}', file=sys.stderr)
        sys.exit(1)

    json_data = json.loads(args.input.read_text())
    n_bytes, n_entries = pack(json_data, args.output)
    print(f'wrote {args.output}')
    print(f'  {n_entries:,} entries  '
          f'({n_bytes:,} bytes / {n_bytes / 1024:.1f} KB)')

    raw_json = args.input.stat().st_size
    print(f'  source JSON: {raw_json:,} bytes / {raw_json / 1024:.1f} KB')
    print(f'  shrink: {n_bytes / raw_json:.1%}')

    # Gzip estimate for comparison.
    import gzip
    gz = gzip.compress(args.output.read_bytes(), compresslevel=9)
    print(f'  bin gzipped: {len(gz):,} bytes / {len(gz) / 1024:.1f} KB')

    if args.verify:
        print()
        print('verifying round-trip:')
        verify(json_data, args.output)


if __name__ == '__main__':
    main()
