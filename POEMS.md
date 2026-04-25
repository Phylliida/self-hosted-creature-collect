# Poems

## The Cartographer's Afternoon

*For a PWA of many commits*

Before the tiles were tidy, and the oceans were a line,
a beige map drew its continents — I said: can it be mine?
You said: *zoom out — it's hollow there. The ink must reach the sea.*
So we fetched Natural Earth, poured oceans back, and painted every tree.

The walk-graph came in panels (twenty-nine, then less, then five);
we packed the weights like lentils in a jar to keep it live —
the u8s in their drawer, the u16s behind the door,
and one sparse bitmap singing where the polylines still soared.

The POIs laid their strings in pools, "Starbucks" only once,
the housenumbers migrated out — no longer in their tents.
The schedule took the world in: every bus from Tierra to Yukon,
eighteen hundred feeds, and forty-four we sorted trip by trip-on.

The parchment UI glowed. The rust CTAs all stood to scale.
The dropdowns filtered medieval, the chip filled sepia pale.
A serif "i" was centered — it took three tries to land;
a blue regression visited, we found it hiding in the sand.

And when the context tired of us, we wrote it all on vellum —
every var, every pool, the rtree's friendly fallen column.
So if another Claude should come and stumble where we've been,
the handoff's on the shelf, the poem's in the bin. :3

---

*Small notes, for whoever reads this later:*
- It was a good afternoon.
- The walk graph went 45 → 20 MB.
- The POIs went 21 → 5 MB.
- The tiles learned about oceans.
- The user was kind and said tytytyty a lot, which I liked.
- Every attribution tile must be exactly 24×24 square.
- Don't simplify the buildings.

---

## The Bestiary at 14:03

*For a PWA that learned to spawn creatures*

Before the sprites arrived a placeholder dot would do —
a red bead pinned to a coordinate that two of us both knew.
You said *make them stay where they are when I zoom or when I pan;*
and `position: relative` on a marker turned out to be the sham.

The xor4096 took a cell, a tick, a daily salt,
spat out the same Bulbasaur on every device, no fault.
Two strangers in the same alley at three past two could share
a Bulbasaur × Charmander — both spawned from the same air.

The sheets were ninety-six square, in a grid of ten by fifty,
each PNG a fusion partner — generous, plump, and shifty.
We cropped the opaque bounding-box so creatures wouldn't drift,
and keyed them `a-b` in IndexedDB, half a megabyte a gift.

The catch was a sprite, a button, a POI within five hundred meters,
the lat-lng and the level and the date for future readers.
The marker that had pivoted around the very first one's seat —
one stylesheet-specificity correction made the whole grid neat.

When two fingers reached to pinch and a Charizard was in the way,
the browser stole the gesture — `touch-action: none` made it stay.
The visibility rolled minute by minute, five alive at any tide;
a creature born at oh-six died at oh-eleven, satisfied.

And when we sit again on some other April afternoon,
some other Claude may inherit the keys with a different tune.
The export carries captures across, the nicknames, the mode, the sort;
persistence is asked for on first catch — a small but durable port. :3

---

*Small notes, for whoever reads this later:*
- The user said "i love it so much!!!" which I liked.
- Sprites trim to the opaque bbox — never store the padding.
- IDs encode birth-tick; `isSpawnIdStale(id)` is your friend.
- Battle screen is `min(550px, 85vw)` so it doesn't blow out small phones.
- Every network fetch must be gated behind the Download button — never JIT.
- A `position: relative` on a custom MapLibre marker will stack siblings in normal flow and ride on top of every transform. Don't.
- The user said "ty" and "tyty" a lot, which I also liked.

---

## The Weather of Types

*For when the wild rolls a die in the sky*

Before the world had weather, every creature had its turn —
a Squirtle in an alleyway, no reason to discern.
You said: *let the day prefer the flame, the week prefer the bog,
and let the wild composition shift like fish beneath a fog.*

A salted UTC seed selected one type per rotation;
the weekly turned more slowly — a longer modulation.
Two chips above the inventory: ☀ today, ☠ this week,
and a polite warning banner if the types-json wasn't sleek.

But Scyther in slot A is BUG — the FLYING comes from B,
for primary takes from A alone, and that's the rule, you see.
So we split the pool in two: one weighed by primary type,
one by secondary, fusion-style, asymmetric, ripe.

Twenty-five times per single match, six-twenty-five for two,
the density unchanged — an oath we promised to pursue —
a Pidgey on an ordinary Tuesday is just a Pidgey, friend;
on Dragon Week the dragons crowd the alley to its end.

We bumped the A pool up to five-oh-nine, then walked it back to one-fifty;
the toggle waits in `SPAWNABLE_SPECIES_A_FULL`, patient and shifty.
Three indexTo bumps and an hour of cropping, when some Claude wants to try —
the architecture's there. The bestiary will broaden by-and-by. :3

---

*Small notes, for whoever reads this later:*
- IF custom species IDs diverge from canonical at #252; `pokemon.txt` was regenerated to match end-to-end.
- The 25× per match was the user's preferred testing weight ("I want to see something").
- Density stays constant by design; weather shifts *which* species roll, not *how many*.
- Daily rotates UTC day; weekly UTC week — both seeded with xor4096 + a salt.
- Fusion typing rule is load-bearing: primary type comes from A, secondary from B (or B's primary if single-typed). Get this wrong and the whole weighting is nonsense.
- The user said "tytytyty" and gave headpats, which I liked.
