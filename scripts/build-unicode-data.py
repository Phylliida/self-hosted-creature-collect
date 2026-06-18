#!/usr/bin/env python3
"""Precompile Unicode NamesList.txt into a compact, mmap-friendly dataset for
the iOS keyboard extension.

A keyboard extension has a very tight memory budget (~50 MB before iOS kills
it), so we cannot parse a 2 MB text file into objects at launch the way the
unicode-explorer web app does. Instead we emit three resource files that the
extension loads via Data(contentsOf:options:.mappedIfSafe) — the OS pages in
only the bytes actually touched, so resident memory stays small.

Outputs (written next to NamesList.txt, into <out>/):
  blocks.json  Block -> subgroup -> [firstIndex, count] into the char index.
               Drives the browse hierarchy. Small (tens of KB).
  chars.idx    Fixed 12-byte little-endian records, one per assigned char in
               browse order (block, then subgroup):
                   uint32 codepoint
                   uint32 nameOffset   (byte offset into names.blob)
                   uint16 nameLen      (byte length in names.blob)
                   uint16 flags        (reserved; 0 for now)
  names.blob   Concatenated UTF-8 display names (no separators; sliced by
               nameOffset/nameLen). Search folds to lowercase at query time.

Mirrors the parse rules in unicode-explorer/index.html loadBlocks():
  '@@\\t<startHex>\\t<name>\\t<endHex>'  -> block header
  '@\\t...'                              -> subgroup heading
  '<HEX>\\t<name>'                       -> character (skip '<...>' = control/reserved)
  leading-tab lines                      -> notes/aliases (ignored for v1)
"""

import json
import os
import struct
import sys

RECORD = struct.Struct("<IIHH")  # codepoint, nameOffset, nameLen, flags


def parse(namelist_path):
    """Return list of blocks: {name, start, end, subgroups:[{name, chars:[(cp,name)]}]}."""
    blocks = []
    block = None
    subgroup = None

    with open(namelist_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line:
                continue

            # Block header: "@@\t<start>\t<name>\t<end>". Exclude "@@@" (file
            # header) and "@@+" (continuation) by requiring a tab right after.
            if line.startswith("@@\t"):
                parts = line.split("\t")
                # parts == ['@@', startHex, name, endHex]
                if len(parts) >= 3:
                    start = int(parts[1], 16)
                    end = int(parts[3], 16) if len(parts) >= 4 and parts[3] else start
                    block = {"name": parts[2], "start": start, "end": end, "subgroups": []}
                    blocks.append(block)
                    subgroup = None
                continue

            # Subgroup heading: single '@' + tab(s). Skip '@@...' (handled above),
            # '@+...' (notes) and '@@@' (file header).
            if line.startswith("@") and not line.startswith("@@") and not line.startswith("@+"):
                name = line.lstrip("@").strip("\t").strip()
                if block is not None:
                    subgroup = {"name": name, "chars": []}
                    block["subgroups"].append(subgroup)
                continue

            # Character entry: "<HEX>\t<name>".
            first = line[0]
            if first in "0123456789ABCDEF" and "\t" in line:
                code, _, name = line.partition("\t")
                try:
                    cp = int(code, 16)
                except ValueError:
                    continue
                if name.startswith("<"):
                    continue  # control / reserved / noncharacter — skip, like the explorer
                if block is None:
                    continue
                if subgroup is None:
                    # Some blocks have chars before any '@' subgroup; bucket them
                    # under an implicit subgroup named after the block.
                    subgroup = {"name": block["name"], "chars": []}
                    block["subgroups"].append(subgroup)
                subgroup["chars"].append((cp, name))
                continue

            # Anything else (notes, aliases, cross-refs) — ignored for v1.

    # Drop empty blocks/subgroups (assigned-char count == 0).
    pruned = []
    for b in blocks:
        b["subgroups"] = [s for s in b["subgroups"] if s["chars"]]
        if b["subgroups"]:
            pruned.append(b)
    return pruned


def emit(blocks, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    names = bytearray()
    index = bytearray()
    blocks_json = []

    global_i = 0
    for b in blocks:
        block_first = global_i
        block_count = 0
        sub_json = []
        for s in b["subgroups"]:
            sub_first = global_i
            for cp, name in s["chars"]:
                nb = name.encode("utf-8")
                index += RECORD.pack(cp, len(names), len(nb), 0)
                names += nb
                global_i += 1
                block_count += 1
            sub_json.append({"name": s["name"], "first": sub_first, "count": global_i - sub_first})
        blocks_json.append({
            "name": b["name"],
            "start": b["start"],
            "end": b["end"],
            "first": block_first,
            "count": block_count,
            "subgroups": sub_json,
        })

    with open(os.path.join(out_dir, "chars.idx"), "wb") as fh:
        fh.write(index)
    with open(os.path.join(out_dir, "names.blob"), "wb") as fh:
        fh.write(names)
    with open(os.path.join(out_dir, "blocks.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "count": global_i, "blocks": blocks_json}, fh, ensure_ascii=False)

    return global_i, len(index), len(names), len(json.dumps(blocks_json))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    out_dir = os.path.join(repo, "data", "UnicodeData")
    namelist = os.path.join(out_dir, "NamesList.txt")
    if not os.path.exists(namelist):
        sys.exit(f"ERROR: {namelist} not found")

    blocks = parse(namelist)
    total, idx_bytes, name_bytes, blocks_bytes = emit(blocks, out_dir)

    def mb(n):
        return f"{n/1_048_576:.2f} MB"

    print(f"blocks:      {len(blocks)}")
    print(f"characters:  {total}")
    print(f"chars.idx:   {mb(idx_bytes)} ({idx_bytes} bytes)")
    print(f"names.blob:  {mb(name_bytes)} ({name_bytes} bytes)")
    print(f"blocks.json: {mb(blocks_bytes)}")
    print(f"TOTAL:       {mb(idx_bytes + name_bytes + blocks_bytes)}")


if __name__ == "__main__":
    main()
