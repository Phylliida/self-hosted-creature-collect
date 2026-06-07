"""Shared species pool for the bundled-data pipeline.

Single source of truth for which species the bundle includes. Every
pipeline script (build-bundled-data.py, generate_sprite_packs.py,
generate_candy_images.py, generate_egg_images.py) imports from here so
the same allowed-id set drives sheet sizes, alpha scans, filtering, and
manifest emission.

Currently: gen 1 (PIF/national 1..150) plus the gen-2/3/4 type-coverage
additions chosen to bring every type to >=5 base-form non-legendary
representatives. See HANDOFF.md type-coverage notes for the rationale.

IMPORTANT: IDs are **PIF internal IDs** (from species.dat), not national
dex numbers. Gen 1 happens to match (PIF 1 = national 1 = Bulbasaur),
and most of gen 2 matches too, but gen 3+ diverges significantly
(Mawile's national id is 303 but PIF assigns it 300; PIF 303 is
"Anorith"). When extending this list, look up each PIF id by running:
    ruby extract-pif-dat.rb data/InfiniteFusion/Data/species.dat
        | jq '.[] | select(.real_name=="<NAME>") | .id_number'
"""

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
]

GEN1_RANGE = range(1, 151)
ALLOWED_SPECIES: list[int] = sorted(set(GEN1_RANGE) | set(EXTRA_SPECIES))
ALLOWED_SET: frozenset[int] = frozenset(ALLOWED_SPECIES)
MAX_SPECIES: int = ALLOWED_SPECIES[-1]  # 503 with current EXTRA_SPECIES (Mightyena)
