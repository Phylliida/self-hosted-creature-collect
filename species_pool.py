"""Shared species pool for the bundled-data pipeline.

Single source of truth for which species the bundle includes. Every
pipeline script (build-bundled-data.py, generate_sprite_packs.py,
generate_candy_images.py, generate_egg_images.py) imports from here so
the same allowed-id set drives sheet sizes, alpha scans, filtering, and
manifest emission.

Currently (default / creature-fusion): every species whose *national*
dex id falls in gens 1–3 (1–386 via the mapping), the curated
type-coverage additions (EXTRA_SPECIES), and the later-gen members of
those families (FAMILY_CLOSURE_EXTRA — gen-4 evolutions/babies pulled
in by the family closure over the full species.dat graph). Before
2026-08-10 the default pool was gen 1 (PIF 1..150) + EXTRA_SPECIES.

IMPORTANT: IDs are **PIF internal IDs** (from species.dat), not national
dex numbers. Gen 1 happens to match (PIF 1 = national 1 = Bulbasaur),
and most of gen 2 matches too, but gen 3+ diverges significantly
(Mawile's national id is 303 but PIF assigns it 300; PIF 303 is
"Anorith"). When extending this list, look up each PIF id by running:
    ruby extract-pif-dat.rb data/InfiniteFusion/Data/species.dat
        | jq '.[] | select(.real_name=="<NAME>") | .id_number'

Alternate mode: set CC_SPECIES_GENS (e.g. "1,2,3,4,5") to build the pool
as every species whose *national* dex number falls in the selected
generation ranges, using the NAT_DEX_MAPPING parsed from the SplitNames.rb
at CC_SPLITNAMES_RB (default: the IF1 copy). This drives the IF2
generation-subset packs (see build-if2-packs.py).
"""

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# National-dex boundaries per generation (inclusive).
GEN_NATIONAL_RANGES: dict[int, tuple[int, int]] = {
    1: (1, 151),
    2: (152, 251),
    3: (252, 386),
    4: (387, 493),
    5: (494, 649),
    6: (650, 721),
    7: (722, 809),
}

# Legendary/mythical species by national dex, per generation. Used for
# completion scoring (legendaries don't count) and spawn exclusion.
LEGENDARY_NATIONAL: dict[int, list[int]] = {
    1: [144, 145, 146, 150, 151],
    2: [243, 244, 245, 249, 250, 251],
    3: [377, 378, 379, 380, 381, 382, 383, 384, 385, 386],
    4: [480, 481, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493],
    5: [638, 639, 640, 641, 642, 643, 644, 645, 646, 647, 648, 649],
    6: [716, 717, 718, 719, 720, 721],
    7: [785, 786, 787, 788, 789, 790, 791, 792, 800, 801, 802, 807],
}

# Baby Pokémon by national dex — pre-evolutions the candy root promotes
# past (mirrors CANDY_ROOT_BABIES in static/creatures.js, which only
# lists the gen-2 babies of gen-1 species; gens mode adds the rest).
BABY_NATIONAL: list[int] = [
    172, 173, 174, 175, 236, 238, 239, 240,      # gen 2
    298, 360,                                    # gen 3 (Azurill, Wynaut)
    406, 433, 438, 439, 440, 446, 447, 458,      # gen 4
]

DEFAULT_SPLITNAMES_RB = (
    ROOT / "data" / "InfiniteFusion" / "Data" / "Scripts"
    / "052_InfiniteFusion" / "Fusion" / "SplitNames.rb"
)


def load_nat_dex_mapping(path: Path) -> dict[int, int]:
    """Parse GameData::NAT_DEX_MAPPING (PIF id -> national dex) from a
    SplitNames.rb file. Ids absent from the map are identity."""
    text = path.read_text(encoding="utf-8")
    m = re.search(r"NAT_DEX_MAPPING\s*=\s*\{(.*?)\}", text, re.S)
    if not m:
        raise ValueError(f"NAT_DEX_MAPPING not found in {path}")
    return {
        int(k): int(v)
        for k, v in re.findall(r"(\d+)\s*=>\s*(\d+)", m.group(1))
    }


def env_path(name: str, default: Path) -> Path:
    """Path override from an env var; relative paths resolve against
    the repo root. Used by the pipeline scripts so build-if2-packs.py
    can point them at the InfiniteFusion2 tree / alt output dirs."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p


# PIF ids that exist at all in the data set (upper bound for gens mode).
# IF2 tops out at PIF 572; ids beyond that have no sprites/species data.
PIF_ID_MAX = 572

# PIF IDs for the 42-species gen-2/3/4 expansion. Each comment is the
# canonical name + national-dex id for cross-reference.
EXTRA_SPECIES: list[int] = [
    # Gen 2 families
    179, 180, 181,    # Mareep, Flaaffy, Ampharos          (national 179,180,181)
    200, 255,         # Misdreavus, Mismagius              (national 200, 429)
    214,              # Heracross                          (national 214)
    215, 262,         # Sneasel, Weavile                   (national 215, 461)
    220, 221, 274,    # Swinub, Piloswine, Mamoswine       (national 220, 221, 473)
    227,              # Skarmory                           (national 227)
    209, 210,         # Snubbull, Granbull                 (national 209, 210)
    198, 256,         # Murkrow, Honchkrow                 (national 198, 430)
    228, 229,         # Houndour, Houndoom                 (national 228, 229)
    # Gen 3 families
    300,              # Mawile                             (national 303)
    390, 391, 333,    # Aron, Lairon, Aggron               (national 304, 305, 306)
    405, 357,         # Shuppet, Banette                   (national 353, 354)
    311, 312, 313,    # Duskull, Dusclops, Dusknoir        (national 355, 356, 477)
    427, 428, 429,    # Snorunt, Glalie, Froslass          (national 361, 362, 478)
    395, 396, 336,    # Bagon, Shelgon, Salamence          (national 371, 372, 373)
    291, 292, 293,    # Beldum, Metang, Metagross          (national 374, 375, 376)
    310,              # Absol                              (national 359 — pure Dark, standalone)
    421,              # Sableye                            (national 302 — Dark/Ghost, standalone)
    # Gen 4 families
    295,              # Spiritomb                          (national 442)
    297, 298, 299,    # Gible, Gabite, Garchomp            (national 443, 444, 445)
    # Eeveelutions — the rest of Eevee's family. Eevee/Vaporeon/Jolteon/
    # Flareon are already in gen 1; we're filling in the post-gen-1 forms.
    196,              # Espeon                             (national 196 — Psychic)
    197,              # Umbreon                            (national 197 — Dark)
    271,              # Leafeon                            (national 470 — Grass)
    272,              # Glaceon                            (national 471 — Ice)
    339,              # Sylveon                            (national 700 — Fairy)
    # Nosepass line — pure Rock base + its Rock/Steel evolution
    325, 326,         # Nosepass, Probopass                (national 299, 476)
]

# Later-gen members of gen 1–3 families, pulled in by the family
# closure over the full IF1 evolution graph (species.dat). The default
# pool is gen 1–3 (national 1–386 via the mapping) + EXTRA_SPECIES +
# these — "every pokémon from gen 1–3 and all of their families".
FAMILY_CLOSURE_EXTRA: list[int] = [
    254,              # Ambipom     (national 424 — Aipom line)
    257,              # Bonsly      (national 438 — Sudowoodo baby)
    258,              # Mime Jr.    (national 439 — Mr. Mime baby)
    259,              # Happiny     (national 440 — Chansey baby)
    260,              # Munchlax    (national 446 — Snorlax baby)
    261,              # Mantyke     (national 458 — Mantine baby)
    263, 264, 265,    # Magnezone, Lickilicky, Rhyperior (462, 463, 464)
    266, 267, 268,    # Tangrowth, Electivire, Magmortar (465, 466, 467)
    269, 270,         # Togekiss, Yanmega (468, 469)
    273,              # Gliscor     (national 472)
    275,              # Porygon-Z   (national 474)
    288,              # Gallade     (national 475 — Kirlia branch)
    352,              # Roserade    (national 407 — Roselia line)
    400,              # Budew       (national 406 — Roselia baby)
    557,              # Chingling   (national 433 — Chimecho baby)
]

GEN1_RANGE = range(1, 151)

# Spawnable species for the pool. Legacy curated gen-1 list below —
# kept for reference against SPAWNVABLE_SPECIES_A in static/spawns.js
# (the client fallback for pool-file-less bundles). The default pool
# and gens mode both set this to None and derive instead (pool minus
# in-pool evolution targets minus legendaries, computed by
# build-bundled-data.py).
SPAWNABLE_SPECIES: list[int] | None = [
    1, 4, 7, 10, 13, 16, 19, 21, 23, 25, 27, 29, 32, 35, 37, 39, 41,
    43, 46, 48, 50, 52, 54, 56, 58, 60, 63, 66, 69, 72, 74, 77, 79,
    81, 83, 84, 86, 88, 90, 92, 95, 96, 98, 100, 102, 104, 106, 107,
    108, 109, 111, 113, 114, 115, 116, 118, 120, 122, 123, 124, 125,
    126, 127, 128, 129, 131, 132, 133, 137, 138, 140, 142, 143, 147,
    179, 198, 200, 209, 214, 215, 220, 227, 228, 291, 295, 297, 300,
    310, 311, 390, 395, 405, 421, 427, 325,
]

# Legendary PIF ids for the legacy gen-1 pool (Articuno/Zapdos/Moltres/
# Mewtwo/Mew). Mirrors LEGENDARY_SPECIES_SET in static/creatures.js
# (its hardcoded fallback). Both the default pool and gens mode now
# override this via _gens_legendaries.
LEGENDARY_SPECIES: set[int] = {144, 145, 146, 150, 151}

# Baby pre-evolutions skipped as candy roots (mirrors CANDY_ROOT_BABIES
# in static/creatures.js — its gen-2-only hardcoded fallback). Both the
# default pool and gens mode now override this via _gens_pif_ids.
CANDY_ROOT_BABIES: set[int] = {172, 173, 174, 175, 236, 238, 239, 240}


def _gens_pool(gens: list[int]) -> list[int]:
    mapping = load_nat_dex_mapping(
        Path(os.environ.get("CC_SPLITNAMES_RB", DEFAULT_SPLITNAMES_RB))
    )
    ranges = [GEN_NATIONAL_RANGES[g] for g in gens]
    out = []
    for pif_id in range(1, PIF_ID_MAX + 1):
        national = mapping.get(pif_id, pif_id)
        if any(lo <= national <= hi for lo, hi in ranges):
            out.append(pif_id)
    return out


def _gens_legendaries(gens: list[int]) -> set[int]:
    mapping = load_nat_dex_mapping(
        Path(os.environ.get("CC_SPLITNAMES_RB", DEFAULT_SPLITNAMES_RB))
    )
    inverse = {nat: pif for pif, nat in mapping.items()}
    out = set()
    for g in gens:
        for nat in LEGENDARY_NATIONAL.get(g, []):
            out.add(inverse.get(nat, nat))
    return out


def _gens_pif_ids(nationals: list[int]) -> set[int]:
    """Map national-dex ids back to PIF ids via the active SplitNames.rb
    mapping (inverse of NAT_DEX_MAPPING; identity when unmapped)."""
    mapping = load_nat_dex_mapping(
        Path(os.environ.get("CC_SPLITNAMES_RB", DEFAULT_SPLITNAMES_RB))
    )
    inverse = {nat: pif for pif, nat in mapping.items()}
    return {inverse.get(nat, nat) for nat in nationals}


_gens_env = os.environ.get("CC_SPECIES_GENS", "").strip()
if _gens_env:
    _gens = sorted({int(g) for g in _gens_env.split(",") if g.strip()})
    ALLOWED_SPECIES: list[int] = _gens_pool(_gens)
    LEGENDARY_SPECIES = _gens_legendaries(_gens) & frozenset(ALLOWED_SPECIES)
    CANDY_ROOT_BABIES = _gens_pif_ids(BABY_NATIONAL) & frozenset(ALLOWED_SPECIES)
    SPAWNABLE_SPECIES = None  # derive: pool - in-pool evo targets - legendaries
else:
    # Default creature-fusion pool: every gen 1–3 species (national
    # 1–386 via the mapping), the curated type-coverage extras, and the
    # later-gen members of those families. Spawnable/legendaries/babies
    # derive the same way gens mode does.
    ALLOWED_SPECIES = sorted(
        set(_gens_pool([1, 2, 3]))
        | set(EXTRA_SPECIES)
        | set(FAMILY_CLOSURE_EXTRA))
    LEGENDARY_SPECIES = _gens_legendaries([1, 2, 3]) & frozenset(ALLOWED_SPECIES)
    CANDY_ROOT_BABIES = _gens_pif_ids(BABY_NATIONAL) & frozenset(ALLOWED_SPECIES)
    SPAWNABLE_SPECIES = None  # derive: pool - in-pool evo targets - legendaries

ALLOWED_SET: frozenset[int] = frozenset(ALLOWED_SPECIES)
MAX_SPECIES: int = ALLOWED_SPECIES[-1]  # 429 with current EXTRA_SPECIES (Froslass)
