#!/usr/bin/env python3
"""Simulate degree-2 contraction on a walk.bin file and report savings.

A walk graph from OSM has tons of intersection-internal nodes — every
shape vertex along a street segment is its own node. Pathfinding only
ever needs to make decisions at intersections (degree >= 3). Every
degree-2 (or degree-1) interior node can be contracted into the
adjacent edge without changing any shortest-path result, just bumping
the edge weight to the sum of the merged edges.

This script doesn't modify anything — it just iteratively contracts
degree-2 nodes in-memory and reports before/after counts so we can
decide whether the full CH-style implementation is worth pursuing.

Usage:
    python3 analyze-walk-contraction.py regions/region-0361/walk.bin
    python3 analyze-walk-contraction.py data/north-america-latest.walk.sqlite  # not supported
    python3 analyze-walk-contraction.py regions/*/walk.bin                       # sums across all

For each input file:
  - Parses the WALK v3 header to extract edgeFrom / edgeTo
  - Builds an undirected adjacency multiset
  - Iteratively contracts degree-2 nodes
  - Prints node/edge counts before & after, plus % reduction
"""
import gzip
import struct
import sys
from collections import defaultdict
from pathlib import Path


def parse_walk_edges(path: Path):
    """Return (node_count, edge_count, list_of_(from, to)).
    Handles both raw and gzip-wrapped files transparently."""
    data = path.read_bytes()
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    magic = data[:4]
    if magic != b'WALK':
        raise ValueError(f'{path}: bad magic {magic!r}')
    version = struct.unpack_from('<I', data, 4)[0]
    if version != 3:
        raise ValueError(f'{path}: unsupported version {version}')
    N = struct.unpack_from('<I', data, 8)[0]
    E = struct.unpack_from('<I', data, 12)[0]
    nodes_start = 48
    edges_start = nodes_start + 16 * N
    edge_from = struct.unpack_from(f'<{E}I', data, edges_start)
    edge_to   = struct.unpack_from(f'<{E}I', data, edges_start + 4 * E)
    return N, E, list(zip(edge_from, edge_to))


def contract_degree2(node_count: int, edges) -> dict:
    """Run iterative degree-2 contraction. Returns a stats dict.

    Treats the graph as undirected (each edge contributes to both endpoints'
    degree). Self-loops + multi-edges are tolerated — when contracting
    A--B--C, if there's already an A--C edge, we add a parallel one
    rather than skip (this is the same behavior a real contraction would
    pick: both edges represent legitimate path alternatives with their
    own weights).
    """
    # adj[u] = list of (v, edge_index) — preserves multi-edges and
    # lets us cheaply remove specific edges when contracting.
    adj = defaultdict(list)
    next_eidx = len(edges)
    for i, (u, v) in enumerate(edges):
        adj[u].append((v, i))
        adj[v].append((u, i))

    # Compute the actual node set (some nodes may have no edges).
    nodes_with_edges = set()
    for u, v in edges:
        nodes_with_edges.add(u)
        nodes_with_edges.add(v)

    original_nodes = node_count
    original_edges = len(edges)
    original_connected_nodes = len(nodes_with_edges)

    # Iterative contraction: process every degree-2 node, then re-check
    # in case contractions created new degree-2 nodes (a chain A-B-C-D-E
    # collapses one node at a time, exposing the next).
    contracted = 0
    pass_num = 0
    while True:
        pass_num += 1
        round_contracted = 0
        # Snapshot keys — we'll mutate adj inside the loop.
        for node in list(adj.keys()):
            entries = adj[node]
            if len(entries) != 2:
                continue
            (a, ea), (b, eb) = entries[0], entries[1]
            if a == node or b == node:
                # Self-loop on this node — leave it alone, it's not a
                # pure pass-through degree-2.
                continue
            if a == b:
                # Both edges go to the same neighbor (degree-2 with
                # duplicate neighbor = a "bubble"). Leave it.
                continue
            # Remove the two old edges from a's and b's adjacency.
            adj[a] = [(v, i) for (v, i) in adj[a] if i != ea and i != eb]
            adj[b] = [(v, i) for (v, i) in adj[b] if i != ea and i != eb]
            # Drop the degree-2 node entirely.
            del adj[node]
            # Stitch a new super-edge connecting a <-> b.
            new_e = next_eidx
            next_eidx += 1
            adj[a].append((b, new_e))
            adj[b].append((a, new_e))
            contracted += 1
            round_contracted += 1
        if round_contracted == 0:
            break
        # Safety: bail if we get into a weird loop. Walk graphs shouldn't
        # need more than ~log(N) passes for typical chain lengths.
        if pass_num > 50:
            break

    # Count what remains.
    remaining_nodes = len(adj)
    # Count unique edges in the residual graph (each edge appears in two
    # adjacency lists in undirected representation).
    seen_edges = set()
    for node, entries in adj.items():
        for (v, eidx) in entries:
            seen_edges.add(eidx)
    remaining_edges = len(seen_edges)

    return {
        'original_nodes': original_nodes,
        'original_connected_nodes': original_connected_nodes,
        'original_edges': original_edges,
        'contracted_count': contracted,
        'remaining_nodes': remaining_nodes,
        'remaining_edges': remaining_edges,
        'passes': pass_num - 1,
    }


def fmt_pct(part: int, whole: int) -> str:
    if whole == 0:
        return '—'
    return f'{(1 - part / whole) * 100:.1f}% reduction'


def report(path: Path, stats: dict) -> None:
    print(f'\n{path}:')
    print(f'  raw header     : {stats["original_nodes"]:>8} nodes  '
          f'{stats["original_edges"]:>8} edges')
    print(f'  with-edges only: {stats["original_connected_nodes"]:>8} nodes  '
          f'(some header nodes have zero edges)')
    print(f'  after CH       : {stats["remaining_nodes"]:>8} nodes  '
          f'{stats["remaining_edges"]:>8} edges')
    print(f'  contraction    : {stats["contracted_count"]:>8} degree-2 nodes '
          f'removed in {stats["passes"]} passes')
    print(f'  node reduction : {fmt_pct(stats["remaining_nodes"], stats["original_connected_nodes"])}')
    print(f'  edge reduction : {fmt_pct(stats["remaining_edges"], stats["original_edges"])}')


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    paths = [Path(a) for a in sys.argv[1:]]
    aggregate = {
        'original_nodes': 0, 'original_connected_nodes': 0, 'original_edges': 0,
        'contracted_count': 0, 'remaining_nodes': 0, 'remaining_edges': 0,
    }
    for p in paths:
        if not p.is_file():
            print(f'skip: {p} (not a file)', file=sys.stderr)
            continue
        try:
            N, E, edges = parse_walk_edges(p)
        except Exception as exc:
            print(f'skip: {p} ({exc})', file=sys.stderr)
            continue
        stats = contract_degree2(N, edges)
        report(p, stats)
        for k in aggregate:
            aggregate[k] += stats[k]
    if len(paths) > 1:
        print('\n── AGGREGATE ──')
        print(f'  raw header     : {aggregate["original_nodes"]:>8} nodes  '
              f'{aggregate["original_edges"]:>8} edges')
        print(f'  with-edges only: {aggregate["original_connected_nodes"]:>8} nodes')
        print(f'  after CH       : {aggregate["remaining_nodes"]:>8} nodes  '
              f'{aggregate["remaining_edges"]:>8} edges')
        print(f'  node reduction : {fmt_pct(aggregate["remaining_nodes"], aggregate["original_connected_nodes"])}')
        print(f'  edge reduction : {fmt_pct(aggregate["remaining_edges"], aggregate["original_edges"])}')


if __name__ == '__main__':
    main()
