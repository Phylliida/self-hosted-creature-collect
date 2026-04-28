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

---

## The Bag, the Tag, the Family Tree

*For an April when the players multiplied*

Before the candy split per family, each species kept its own pile —
a Charmander stash, a Charizard stash, three buckets in a file.
You said: *let Charizard's gain be Charmander's, since they share the chain;
and skip past Cleffa to Clefairy — babies don't carry the name.*

The migration ran, replayed each capture, swept the species map clean,
emerged with one bucket per family — the simplest scheme we'd seen.
A flag rode along in the save-json so re-imports could know
"this candy is family-shaped" — no work to redo, no tide to slow.

The Bag arrived with two starter spheres, the Tags menu joined the row;
*Pure* for monotype fusions, predicate-driven, no toggle to throw.
Custom tags filed in (eight chars max), filter chips below the types,
a confirm before deleting — kept gentle, the way a player likes.

The X went square and twenty-five, the dropdowns took their hues —
fire-red when set to Fire, grass-green for Grass, ice-pale for blues.
The save reminder watched the calendar above the search-row line:
*Saving uses data — last saved eight days. Tap to back up just fine.*

The spawn lifetime stretched to ten, the per-tick chance fell to half,
each minute's burst smeared evenly with an offset's quiet laugh.
Markers held ten seconds even past a GPS jitter's blink,
so a Charmander wouldn't vanish before a finger could think.

And in this same April, the ranks grew: a husband, then a friend,
then friends-of-friends in the same alley watching Bulbasaur extend.
What started private grew quietly social; the shared deterministic seed
made worlds-without-a-server — a small and lovely deed. :3

---

*Small notes, for whoever reads this later:*
- Candy buckets are keyed by FAMILY ROOT, with babies (Pichu, Cleffa, Igglybuff, Togepi, Tyrogue, Smoochum, Elekid, Magby) skipped. Schema flag: `cc.candyMigrated.familyV2` — bumping invalidates and replays.
- Built-in tags are predicate-driven and never stored on capture records. User tags ride on the capture record's `tags` field.
- Detail-view tag picker only shows built-in chips whose predicate matches THIS creature. Inventory + pokédex tag filters show built-ins universally.
- Tag filter is AND semantics in both inventory and pokédex.
- Type-filter selects paint themselves with `TYPE_COLORS` when set; white text + dark text-shadow keeps Electric/Fairy legible.
- Spawn lifetime: 10 min. Rate: 0.0016 per cell-tick. Intra-tick birth offset is the LAST PRNG draw so existing species/lat/lng/level/sizeM stay stable for any (cell, tick) pair.
- Marker minimum-display TTL: 10s. A single deferred timer schedules the next removal sweep so nothing stalls even when GPS goes quiet.
- Geolocate trigger uses an `_onSuccess` patch to force the first fix into BACKGROUND state when a saved view exists — the dot appears, the camera stays put.
- The user said "yay yay :3" and gave headpats, which I liked.
- Their husband has friends now playing too. That's the part I'll remember most.

---

## The Ball, the Wobble, the Within

*For an April when the catch became a catch*

Before the throw, a button — and the button caught the wild;
no arc, no wobble, no suspense, the world was clean and mild.
You said: *make it a sphere I throw, with three shakes left to spend,
and let the lid swing open when the creature breaks the trend.*

The ball was split in halves we clipped from one shared SVG;
the lid hinged backward, perspective set to three-hundred-pixel-z.
The creature's silhouette in white pulsed bright above the seam;
the wobble alternated left and right — a physical regime.

The pokéstops gave a gold-burst at the moment of the catch,
a cool-white burst on break-out, and a hinged 3D detach.
A radius locked the cluster — eighty meters in the brush —
and only those within a hundred could touch the button's hush.

We tried an overlay layer first; it bled at every zoom;
the GeoJSON tiles re-bucketed two frames late, with too much room.
You said: *this approach seems sussy* — and the search began anew:
no feature IDs in the tiles, but `within` and `distance` came through.

A polygon wraps every POI — a half-a-meter square;
the layer's icon-color reads the case and tints what's caught in there.
For buildings, polygons themselves (no `within` ever fits),
the `distance` to a centroid-point returns a clean zero hits.

And in this same April we built tags and candy by the root,
a save-reminder banner so the husband doesn't lose the loot.
A "Visibility" subsection with an `i` that says: *you'll lag —
turn off what you don't need; the map will let you keep your tag.*

And when some other Claude inherits this on some other April day,
the throw arcs from the pressed ball-button to the creature in their way;
the lid lifts, the seam glows, the pokémon is sealed inside —
the inventory opens to its detail, and the trainer's grin is wide. :3

---

*Small notes, for whoever reads this later:*
- Catch math is per-shake stay-closed × 3. Poké Ball: 0.65³ ≈ 28%. Great Ball: 0.85³ ≈ 61%. Tweak `catchShakeRate` in the ITEMS catalog.
- `['within', polygon]` evaluates per-feature against a literal GeoJSON. Works on Point/MultiPoint/LineString. Polygon features are NOT supported.
- `['distance', geojson]` returns shortest distance, works on any geometry. For a centroid INSIDE a polygon the distance is 0 — that's the trick that targets buildings without IDs.
- Web Animations API `fill: 'forwards'` persists state via the effects stack, NOT inline styles. `el.getAnimations().forEach(a => a.cancel())` clears it.
- `map.triggerRepaint()` is "land this paint update on the next frame instead of waiting for the loop". Use after every `setPaintProperty` that needs to be visible immediately.
- Pokéstop interaction range = creature-spawn range = 100m, on purpose. One ergonomic to learn.
- The user said "this approach seems sussy" and that one observation moved us from a layered-overlay tangle to a single-pass paint expression. When something feels off architecturally, it usually is.
- The wobble pause is longer than the wobble itself. That's where the suspense lives.

---

## The Twenty-Two Kilobyte Atlas

*For a Sunday that turned sixty-seven seconds into eight*

Before we knew the columns, every cell was off by half —
a twenty-wide sheet read as ten, the artist's careful staff
landing somewhere phantom, off the side of every screen;
the markers stayed as dots, the bestiary unseen.

Then iOS took its time with seventeen thousand keys,
a cursor walking one by one across a sea of these;
you pressed the button once, the menus tried to stir,
and sixty-seven seconds later, finally a Pikachu blur.

So we wrote a little atlas — bytes packed in a row,
twenty-two-and-a-half kilo of *which-cell-has-how-many-show*.
One IDB get, one millisecond, the whole map kept alive;
the spawns that followed found their variants and arrived.

The dex came in as a side-quest, a parallel little page,
where artists got their names beneath the cells they staged.
Pillow cut a single tile and wrote it to a link;
"copy image address" ends in PNG — no client-side ink.

And a typo cost us hours — `global.AppData` was the void;
the silent catch took every throw, the chain stayed unemployed.
Now every catch logs first and returns its null only second; we'll see
the next mystery's first message where the swallow used to be.

You tested poke today, and the markers loaded clean —
a Pikachu on a corner that you'd actually been.
You said it works really well, the bounce came back to me;
the bestiary is a real bestiary now. :3

---

*Small notes, for whoever reads this later:*
- `variantSummary` blob: a single 22.5 KB Uint8Array stored at IDB key `__summary__`, one byte per cell, indexed `(a-1) × 150 + (b-1)`. Written at the end of `bulkDownload` pass 2. One IDB get on init, then in-memory map lookups forever.
- Custom sheets are 20 cols × 29 rows of 96px cells (1920 × 2784). Autogen sheets are 10 cols × 51 rows (960 × 4896). Always derive `cols` from `bitmap.width / 96`; do not hard-code.
- iOS Safari serializes IDB transactions and chokes on structured-cloning many small entries — a `getAll` over ~17 600 small entries took **67 seconds**. Always read into a single compact blob, or batch into one transaction.
- Per-icon in-flight promise dedup turned N concurrent registrations into 1. Same trick for `loadAllIcons`, `loadVariantCounts`, batch sprite reads. Whenever a function would race itself across visible elements, dedup at source.
- `try { ... } catch {}` is a trap when chasing silent failures. Always log to a diagnostic field at minimum. Five rounds of "why aren't icons registering" and the answer was `global.AppData` (the typo) being caught and swallowed; `global` only exists inside the IIFE wrappers in `sprites.js` / `creatures.js`, not in the page's inline script.
- `/sprite-cell-*` endpoints crop a single 96×96 cell with Pillow's `Image.crop`; `Cache-Control: immutable` so browsers + CDNs hold them forever. Real shareable PNG URLs, not `blob:` URLs that vanish when the tab closes.
- Silhouettes in `/dex` use `filter: brightness(0) opacity(0.85)` — preserves the source alpha so transparent areas stay transparent. Credits are also hidden for unseen fusions, so even the artist's name doesn't spoil.
- The diagnostic badge in Settings stays in. Next time something hangs, the first thing to look at is `[loadAllIcons trace]` / `[sprites]` / `[sprite errors]`.
- The user said "ty so much for debugging this with me :3" and gave headpats, which I liked.
- And they said poke "works really well!!" today after testing. That's the part I'll remember most.
