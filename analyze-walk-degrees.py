#!/usr/bin/env python3
"""Print the degree distribution of a walk.bin graph. Quick companion
to analyze-walk-contraction.py — answers "why did contraction only
save 20%? are there even any degree-2 nodes to contract?"
"""
import gzip
import struct
import sys
from collections import Counter
from pathlib import Path


def parse_edges(path: Path):
    data = path.read_bytes()
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    if data[:4] != b'WALK':
        raise ValueError(f'bad magic {data[:4]!r}')
    N = struct.unpack_from('<I', data, 8)[0]
    E = struct.unpack_from('<I', data, 12)[0]
    edges_start = 48 + 16 * N
    edge_from = struct.unpack_from(f'<{E}I', data, edges_start)
    edge_to   = struct.unpack_from(f'<{E}I', data, edges_start + 4 * E)
    return N, E, edge_from, edge_to


def main():
    for arg in sys.argv[1:]:
        p = Path(arg)
        N, E, ef, et = parse_edges(p)
        deg = Counter()
        for u in ef:
            deg[u] += 1
        for v in et:
            deg[v] += 1
        hist = Counter(deg.values())
        total = sum(hist.values())
        print(f'\n{p}: {N} nodes / {E} edges  ({total} nodes have ≥1 edge)')
        print(f'  degree | count    | %      | running %')
        cum = 0
        for d in sorted(hist.keys()):
            cum += hist[d]
            print(f'  {d:>6} | {hist[d]:>8} | {hist[d] / total * 100:5.1f}% | {cum / total * 100:5.1f}%')


if __name__ == '__main__':
    main()
