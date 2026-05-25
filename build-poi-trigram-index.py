#!/usr/bin/env python3
"""Build a custom trigram inverted index for one region's POIs.

Size estimate companion to build-poi-search-db.py — produces a
sibling poi-trigram.bin file in the same per-region binary-format
family as routing.bin / boundaries.bin. Goal: smallest possible
substring-search index alongside the existing poi.bin.

Algorithm:
  1. For each POI, lowercase + diacritics-stripped (name + " " + category)
     becomes the indexed text.
  2. Extract all 3-codepoint substrings ("trigrams").
  3. Hash each trigram to a Uint32 (FNV-1a 32-bit).
  4. Build inverted index: trigram_hash → sorted list of POI IDs that
     contain it.
  5. Delta-encode each posting list as varints (LEB128), concatenated.

At query time (in the runtime, not this script):
  1. Lowercase + normalize the query string the same way.
  2. Extract its trigrams, hash each.
  3. Binary-search each hash in the trigram table; pull its postings
     byte range; varint-decode the deltas into an in-memory list.
  4. Intersect all decoded posting lists (smallest first).
  5. Verify substring match on the survivor candidates by looking up
     name/category in the sibling poi.bin (kills hash collisions +
     handles boundary cases).

────────────────────────────────────────────────────────────────────
poi-trigram.bin v2 layout (all little-endian):

  off  size            field
  ─────────────────────────────────────────────────────────
  0    4               magic = 'POIS'  (POI search)
  4    4               version = 2
  8    4               N (poi count — for sanity-checking against poi.bin)
  12   4               T (unique trigram count)
  16   4               postingsByteLen (size of the postings section)
  20   12              reserved
  32                   ── data sections begin ──

  off0      4 * T           trigramHash (Uint32, sorted ascending)
  off1      4 * (T+1)       postingStart (Uint32, BYTE offsets into postings)
  off2      postingsByteLen postings (packed varints, delta-encoded per trigram)

  v2 vs v1 changes:
    - REMOVED the lng/lat/nameIdx/catIdx columns. Look those up from
      poi.bin (already loaded at runtime for display data).
    - REMOVED the embedded string pool. Same reason.
    - postings are now varint-encoded deltas instead of Uint32. Each
      trigram's posting list is independently decodable from its byte
      range:
          first_id = varint
          next_id  = first_id + varint   (delta from previous)
          ...
      A trigram with K postings takes roughly K * 2 bytes vs the
      previous K * 4 bytes for sorted IDs in the 0..N range.

Why hash trigrams instead of storing as text:
  - Fixed-size keys (Uint32) → binary search is trivial.
  - Unicode handling falls out: 3 codepoints can be 3-12 bytes, but
    the hash is always 4 bytes.
  - Hash collisions are filtered by the final substring-verify pass
    against poi.bin's actual name/category strings, so false positives
    don't pollute results.
  - For ~13k unique trigrams in 32-bit hash space, expected
    collisions: 0.04. Negligible.

Runtime contract: poi-trigram.bin is ALWAYS used with the matching
poi.bin loaded. POI IDs in postings are indices into poi.bin's
columnar arrays. No standalone use.

Usage:
    python3 build-poi-trigram-index.py regions/region-0361
"""
import argparse
import gzip
import struct
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path


MAGIC = b'POIS'
VERSION = 2
HEADER_BYTES = 32


def varint_encode(n: int) -> bytes:
    """LEB128 unsigned varint. JS-side decoder is ~10 lines."""
    if n < 0:
        raise ValueError(f'negative varint: {n}')
    out = bytearray()
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


# ── poi.bin reader (same as build-poi-search-db.py) ─────────────────

def _read_poi_bin(path: Path):
    """Returns (lngs, lats, name_idx_arr, cat_idx_arr, string_pool) for
    use both as the inverted-index source AND as the columns we'll
    re-emit into the new file. Keeping the same nameIdx/catIdx convention
    as poi.bin lets us preserve the runtime contract that string-pool
    ordinals are stable across files."""
    data = path.read_bytes()
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    if data[:4] != b'POIB':
        raise ValueError(f'{path}: bad magic {data[:4]!r}')
    version = struct.unpack_from('<I', data, 4)[0]
    if version != 1:
        raise ValueError(f'{path}: unsupported version {version}')
    N = struct.unpack_from('<I', data, 8)[0]
    S = struct.unpack_from('<I', data, 12)[0]
    col_start = 32
    lngs = list(struct.unpack_from(f'<{N}f', data, col_start))
    lats = list(struct.unpack_from(f'<{N}f', data, col_start + 4 * N))
    name_idx = list(struct.unpack_from(f'<{N}i', data, col_start + 8 * N))
    cat_idx = list(struct.unpack_from(f'<{N}i', data, col_start + 12 * N))
    strings_start = col_start + 20 * N
    pool = [None] * S
    p = strings_start
    for i in range(S):
        length = struct.unpack_from('<H', data, p)[0]
        p += 2
        pool[i] = data[p:p + length].decode('utf-8')
        p += length
    return lngs, lats, name_idx, cat_idx, pool


# ── text normalization (must round-trip JS side identically) ────────

def normalize(s: str) -> str:
    """Lowercase + strip diacritics. NFD then drop combining marks.
    Matches what the JS loader will need to do at query time."""
    if not s:
        return ''
    # NFD splits 'é' into 'e' + combining acute. Then we filter out
    # the combining marks (category starts with 'M').
    decomposed = unicodedata.normalize('NFD', s)
    stripped = ''.join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.casefold()


# ── trigram extraction + hashing ────────────────────────────────────

def fnv1a_32(text: str) -> int:
    """32-bit FNV-1a. Same algorithm both sides; deterministic."""
    h = 0x811C9DC5
    for ch in text:
        # encode codepoint to bytes for stable hashing across all
        # plane (BMP + supplementary). Use UTF-8 — the same bytes JS
        # would produce from `new TextEncoder().encode(ch)`.
        for b in ch.encode('utf-8'):
            h ^= b
            h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def trigrams_of(text: str):
    """Yield each 3-codepoint substring. Codepoint, not byte —
    accented characters count as one position after normalize() has
    stripped their combining marks anyway."""
    if len(text) < 3:
        return
    for i in range(len(text) - 2):
        yield text[i:i + 3]


# ── build ────────────────────────────────────────────────────────────

def build_trigram_bin(poi_bin: Path, out_path: Path) -> dict:
    lngs, lats, name_idx_arr, cat_idx_arr, pool = _read_poi_bin(poi_bin)
    N = len(lngs)
    S = len(pool)
    print(f'  read {N} POIs, {S} strings from {poi_bin}')

    # Inverted index: trigram_hash → set of POI IDs.
    # We use Set to dedupe within a single POI (same trigram appears
    # multiple times in a long name → just one posting).
    inverted = defaultdict(set)
    skipped = 0
    for i in range(N):
        ni = name_idx_arr[i]
        ci = cat_idx_arr[i]
        name = pool[ni] if 0 <= ni < S else ''
        cat = pool[ci] if 0 <= ci < S else ''
        text = normalize(name + ' ' + cat) if cat else normalize(name)
        if len(text) < 3:
            skipped += 1
            continue
        for tg in trigrams_of(text):
            inverted[fnv1a_32(tg)].add(i)

    print(f'  generated {len(inverted)} unique trigrams '
          f'({skipped} POIs had <3 chars and were skipped)')

    # Sort trigrams by hash so runtime can binary-search. For each
    # trigram, sort its postings ASC so we can delta-encode them.
    sorted_hashes = sorted(inverted.keys())
    posting_starts = [0]  # byte offsets, not entry indices
    postings_buf = bytearray()
    total_entries = 0
    max_per_trigram = 0
    for h in sorted_hashes:
        ids = sorted(inverted[h])
        total_entries += len(ids)
        max_per_trigram = max(max_per_trigram, len(ids))
        # Delta encoding: first ID is absolute (delta from 0), then
        # each next is delta from previous. All as unsigned varints.
        # Sorted ASC means all deltas are >= 0 and typically small.
        prev = 0
        for v in ids:
            postings_buf.extend(varint_encode(v - prev))
            prev = v
        posting_starts.append(len(postings_buf))
    T = len(sorted_hashes)
    postings_bytes = len(postings_buf)
    avg_bytes_per_entry = postings_bytes / total_entries if total_entries else 0
    print(f'  postings: {total_entries} entries → {postings_bytes:,} bytes '
          f'({avg_bytes_per_entry:.2f} bytes/entry avg, '
          f'max {max_per_trigram:,} entries in one trigram)')

    buf = bytearray()
    # Header (32 bytes).
    buf += MAGIC
    buf += struct.pack('<I', VERSION)
    buf += struct.pack('<I', N)
    buf += struct.pack('<I', T)
    buf += struct.pack('<I', postings_bytes)
    buf += b'\x00' * 12  # reserved
    assert len(buf) == HEADER_BYTES
    # Trigram table (sorted Uint32 hashes).
    buf += struct.pack(f'<{T}I', *sorted_hashes)
    # CSR byte-offset table.
    buf += struct.pack(f'<{T + 1}I', *posting_starts)
    # Postings (packed varints, delta-encoded per trigram).
    buf += postings_buf

    out_path.write_bytes(buf)
    return {
        'pois': N,
        'unique_trigrams': T,
        'total_postings': total_entries,
        'bytes': len(buf),
        'section_bytes': {
            'header': HEADER_BYTES,
            'trigramHash': 4 * T,
            'postingStart': 4 * (T + 1),
            'postings': postings_bytes,
        },
    }


def _format_mb(n: int) -> str:
    if n < 1024:
        return f'{n} B'
    if n < 1024 * 1024:
        return f'{n / 1024:.1f} KB'
    return f'{n / 1048576:.2f} MB'


def _resolve_inputs(argv_paths):
    """Accept poi.bin paths OR region directories OR a parent dir
    containing region subdirs. Returns list of poi.bin Paths."""
    out = []
    for a in argv_paths:
        p = Path(a)
        if p.is_dir():
            pb = p / 'poi.bin'
            if pb.is_file():
                out.append(pb)
                continue
            # Parent dir containing region subdirs?
            for sub in sorted(p.iterdir()):
                sub_pb = sub / 'poi.bin'
                if sub.is_dir() and sub_pb.is_file():
                    out.append(sub_pb)
        elif p.is_file():
            out.append(p)
        else:
            print(f'skip: {p} (not found)', file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='+',
                    help='poi.bin file(s), region director(ies), or a parent dir')
    ap.add_argument('--force', action='store_true',
                    help='overwrite existing poi-trigram.bin files')
    ap.add_argument('--quiet', action='store_true',
                    help='only emit summary lines (no per-region detail)')
    args = ap.parse_args()

    poi_paths = _resolve_inputs(args.paths)
    if not poi_paths:
        print('no poi.bin inputs found', file=sys.stderr)
        sys.exit(2)

    written = 0
    skipped = 0
    total_in = 0
    total_out = 0
    total_pois = 0
    total_postings = 0
    total_trigrams = 0
    import builtins
    _real_print = builtins.print
    for pb in poi_paths:
        out_path = pb.parent / 'poi-trigram.bin'
        if out_path.exists() and not args.force:
            skipped += 1
            continue
        try:
            if args.quiet:
                # Mute the per-region progress prints inside build_trigram_bin.
                builtins.print = lambda *a, **kw: None
                try:
                    stats = build_trigram_bin(pb, out_path)
                finally:
                    builtins.print = _real_print
            else:
                print(f'{pb.parent.name}:')
                stats = build_trigram_bin(pb, out_path)
        except Exception as exc:
            builtins.print = _real_print
            print(f'  failed: {exc}', file=sys.stderr)
            continue
        in_size = pb.stat().st_size
        total_in += in_size
        total_out += stats['bytes']
        total_pois += stats['pois']
        total_postings += stats['total_postings']
        total_trigrams += stats['unique_trigrams']
        written += 1
        if args.quiet:
            print(f'  {pb.parent.name}: {stats["pois"]:>6} POIs  '
                  f'poi.bin={_format_mb(in_size):>10}  '
                  f'poi-trigram.bin={_format_mb(stats["bytes"]):>10}')

    print()
    print(f'wrote {written} poi-trigram.bin file(s), '
          f'skipped {skipped} (use --force to overwrite)')
    if written:
        print(f'  {total_pois:,} POIs across {written} regions')
        print(f'  {total_trigrams:,} unique trigrams · {total_postings:,} postings')
        print(f'  total poi.bin (gzipped on disk): {_format_mb(total_in)}')
        print(f'  total poi-trigram.bin: {_format_mb(total_out)}')
        if total_in:
            print(f'  ratio: {total_out / total_in:.2f}× of poi.bin')


if __name__ == '__main__':
    main()
