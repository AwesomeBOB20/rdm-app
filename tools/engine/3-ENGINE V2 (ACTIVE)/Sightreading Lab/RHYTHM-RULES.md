# How RDM rhythm variations are built

Reverse-engineered from Anthony's hand-written `"16s"` family in `generator.js`, which is the reference
implementation. **Every rhythm family must follow these rules.** If a new family looks wrong, check it
against this document before changing anything else.

---

## 1. The model: a rhythm is a bit string

A family is defined by **N slots** (the subdivisions of its span) and a set of **bit strings** over those
slots.

- `1` = an attack (a note starts here)
- `0` = no attack

`"16s"` has N = 4, so `1011` means: attack, nothing, attack, attack.

The bit string is the *rhythm*. Everything else — note values, rests, beaming — is derived from it by the
rules below. Never hand-pick note values; derive them.

---

## 2. The three rules that turn bits into notes

### Rule 1 — a `1` starts a note
Obvious, but it's the anchor for the other two.

### Rule 2 — a `0` AFTER a `1` sustains it. It is never a rest.
The note started at the last `1` grows by one slot. This is the single most important rule and the one
most often got wrong.

```
1110  →  16th, 16th, EIGHTH        ← slot 3's note absorbs slot 4
1100  →  16th, DOTTED EIGHTH       ← slot 2's note absorbs slots 3 and 4
1000  →  QUARTER                   ← one note absorbs the whole beat
```

An internal rest is not the default, but it is not forbidden either — see the exception below and §3.

### Rule 3 — leading `0`s (before the first `1`) ARE a rest
Only the start of the group may be silent, and those slots merge into one rest.

```
0111  →  16th REST, 16th, 16th, 16th
0011  →  EIGHTH REST, 16th, 16th        ← two leading zeros merge
0001  →  DOTTED-EIGHTH REST, 16th
0100  →  16th REST, DOTTED EIGHTH       ← rest, then rule 2 applies
```

### The exception: an internal rest appears where NO note value fits
On a drum a note has no duration — you strike it and it decays — so sustain-vs-rest is purely a
*notation* choice. Sustain is the default. **A rest is used where the sustained note would need a length
that can't be written as one notehead.** Anthony's own words: *"I couldn't find a rhythm that could cover
that space."*

Run `node chk-restwhy.js` — it merges every rest back into the note before it and reports whether that
merge was even possible. Every *forced* rest in the bank is the same case: **k = 5 slots**, split per §3.

| Variant | Sustain would need | |
|---|---|---|
| `5let_10000` | 5 of 5 quintuplet slots | split |
| `6let_110000`, `6let_100001`, `6let_010000` | 5 of 6 sextuplet slots | split |
| `16s` `cmp_6let_*` clones | same, inherited from `6let` | split |

So `6let`'s internal rests are **not** a pedagogical device for showing which partials are struck — no
note value covers that space. Same for `5let_10000`.

The remaining rests *could* have sustained legally (k = 2 or 3), so those are a deliberate look:
`8t_110` "Trip-let-rest", `qt_110` / `qt_101` / `qt_100`, `8s_c_110`, `q_cmp_*`.

### Where the rest goes
When a run must be split, position decides which piece gets the space:

- **Internal** (another attack follows) — grow the note to the largest legal value, leave the smallest
  possible rest. `6let_100001` → **quarter, 16th rest, 16th**. This is what `splitRun()` implements.
- **Trailing** (nothing follows) — the last note keeps the same value as the notes beside it and the
  rest absorbs the whole remainder. `6let_110000` → 16th, 16th, **quarter rest**;
  `6let_101000` → 8th, 8th, **8th rest**. Uniform notes then one rest reads faster than one long note.

Note the trailing convention applies in `6let` even when sustaining would have been legal
(`6let_111000` is 16th, 16th, 16th, dotted-8th rest — k = 4 was available). Straight families sustain
instead: `16s_1100` is 16th + dotted 8th, never 16th + rest. **Match the family you are extending.**

---

## 3. Choosing the written note value

A note covering **k slots** where one slot = the family's base value:

| k slots | Written as | Example, base 16th |
|---|---|---|
| 1 | base | 16th |
| 2 | one step longer | 8th |
| 3 | one step longer, **dotted** | dotted 8th |
| 4 | two steps longer | quarter |
| 6 | two steps longer, **dotted** | dotted quarter |
| 8 | three steps longer | half |
| 12 | three steps longer, **dotted** | dotted half |

The ladder is `32 → 16 → 8 → q → h → w` (`LADDER` in `generator.js`), and the table above is `UNIT_MAP`.

### k = 5, 7, 9, 10, 11 have no single notehead — split them, NEVER tie
**A tie is not acceptable in this material.** When a note's length has no notehead, write the largest
legal note you can, then a rest for the remainder. `splitRun()` in `generator.js` does exactly this:

| k | Written as | In a sextuplet (16th base) |
|---|---|---|
| 5 | 4 + rest 1 | quarter + 16th rest |
| 7 | 6 + rest 1 | dotted quarter + 16th rest |
| 9 | 8 + rest 1 | half + 16th rest |
| 10 | 8 + rest 2 | half + 8th rest |
| 11 | 8 + rest 3 | half + dotted 8th rest |

This is Anthony's own notation. `6let_100001` — attacks on partials 1 and 6 of a sextuplet — is written
**quarter, 16th rest, 16th**, not a tied five. The rest exists because nothing covers that space, not as
a musical statement.

### Dotted families have their own ladder
`dotted8`'s base unit is a dotted 8th, so its ladder is dotted 8th (0.75) → dotted quarter (1.5) →
dotted half (3.0) and only **k = 1, 2, 4** are legal. k = 3 is 2.25 beats, which has no notehead, so it
splits 2 + 1 exactly like `splitRun`. Two dotted 8ths are a dotted quarter — so this family produces real
dotted quarter NOTES (sustains) and dotted quarter RESTS (merged), not a row of dotted-8th rests
(Anthony, 2026-07-21). The full-span single attack `1000` is therefore a dotted half note.

---

## 4. How many variations to generate

**Enumerate every pattern: `2^N − 1`.** A beat can't be silent, so all-zeros never exists. This is what
Anthony hand-wrote for `16s` (15) and `5let16` (31), and since 2026-07-21 every generated family matches
— pass `full = true` to `buildFamily()` and it uses `allBits(N)`.

| Family | N | Variations |
|---|---|---|
| `r43`, `r46` | 4 | 15 |
| `r53`, `r56` | 5 | 31 |
| `7let`, `7let8`, `r73`, `r76` | 7 | 127 |
| `32nd`, `r83`, `r86` | 8 | 255 |

The full run is emitted **first** so `list[0]` is always the family's canonical shape.

Nothing is skipped: `splitRun()` (§3) gives every bit string a legal notation, so all `2^N − 1` survive.

**Weighting** (`bitsWeight`) keeps this usable rather than noisy:
- the full run gets `10 × N`, so it stays common even against 254 siblings
- otherwise weight scales with attack count (1–6): denser patterns are more useful
- a leading rest costs 2, because off-beat entries are harder to read

Sparse patterns are further suppressed at runtime by the Rests slider — at 0 only rest-free variations
survive, and there are still 58–114 of those per large family.

`curateBits()` (the old small hand-picked set) is retained for any family that shouldn't be exhaustive.

**Run `node chk-coverage.js` to prove a family is complete.** It rebuilds every possible bit string and
lists what's absent. As of 2026-07-21 every family reports COMPLETE — total 0 missing. It also groups by
id prefix, which is how sub-families are caught: `16s` holds both the 4-slot 16ths and the 6-slot
`cmp_6let` clones, and each must be complete on its own.

Ids with no trailing bit string are hand-named idioms (`dottedQ`'s 10, `6let`'s 12 front/back-triplet
pairings). They sit outside the grid and are listed, not counted as gaps.

---

## 5. Beaming and stemming

- **Beam everything inside one beat together.** Beam groups follow the beat, not the bar.
- **A rest breaks the beam.** No beam runs over a rest — that's why leading rests are a separate note.
- **Beam count follows the written value**, automatically: 16ths get 2 beams, 32nds get 3. Never draw
  beams by hand; pick the right note value and the beams follow.
- **Never beam across a beat boundary** in simple time, even when a tuplet spans more than a beat — the
  tuplet bracket carries the grouping instead.

### Pick the note value by SPEED, not by arithmetic
When a tuplet's notes are much faster than its written value, re-write it at the next value down. This is
a readability rule and it overrides tidiness:

| Family | Real length per note | Written as |
|---|---|---|
| 4:3 over 1.5 beats | 0.375 | 8th |
| 7:3 over 1.5 beats | 0.214 | **16th** (an 8th would be 2× too long) |
| 8:3 over 0.75 beats | 0.094 | **32nd** |

A reader should be able to judge the speed from the beams before decoding the bracket.

---

## 6. Weights (`w`) — how often a variation appears

| Shape | Weight |
|---|---|
| The full run (all attacks) | **10** |
| Recognised idioms (gallop, reverse gallop) | 7–8 |
| Ordinary sustains | 5–6 |
| Anything starting with a rest | **4–6** (lower — off-beat entries are harder) |
| Collapses to a single plain note (e.g. `1000` → quarter) | 5 |

Rest-containing variants are additionally thinned at runtime by `applyDensityFilter()` so the Rests
slider behaves smoothly, so don't over-weight them here to compensate.

---

## 7. Ids and labels

- **Id:** `<family>_<bits>` — e.g. `16s_1101`, `r43_1011`. The bits must be in the id; it's how a
  variation is identified when something looks wrong on the page.
- **Label:** how a drummer would *say* it — `"1 e & a"`, `"Gallop (1 &a)"`, `"Reverse Gallop"`. For
  generated families `bitsLabel()` produces `"1-3-4"` with a leading `"R "` for off-beat entries.

---

## 8. Tuplets

- Attach `_tuplet: { num_notes, notes_occupied }` to the variation.
- **`notes_occupied` is what the group displaces**, in the family's own note value.
  `4:3` = four notes in the space of three of the same value.
- Set `_tuplet: false` when a variation collapses to a plain note that needs no bracket — e.g. `8t_100`
  is just a quarter note, and a "3" over it would be nonsense.
- **`notes_occupied` distinguishes a ratio rhythm from a plain tuplet.** A real 5-let is `5:4`; a ratio
  five is `5:3`. Counting and sticking branch on this, so it must be right.

---

## 9. Counting and sticking

- **Tuplets and ratio rhythms count by NUMBER** — `1 2 3 4` for a 4:3, `1 2 3 4 5` for a 5:3. Only
  straight subdivisions use syllables (`1 e & a`, `1 trip let`).
- A rest keeps its slot's number, so `1 3 4` correctly shows that slot 2 was silent.
- **Natural sticking alternates R L R L per note** through a tuplet group. Do not map tuplet notes onto a
  beat grid — a 4:3 note is 0.375 of a beat and no whole-number grid can express it.

---

## 10. Placement — a family must fit the bar

The generator packs measures from buckets. A family's span decides which bucket it needs:

| Span | Bucket | Completed by |
|---|---|---|
| 1.0 | standard | — |
| 2.0 / 3.0 | multi-beat | — |
| **0.75** | 0.75 bucket | one 16th → exactly 1 beat |
| **1.5** | 1.5 bucket | a half-beat filler → exactly 2 beats |

**If you add a family with a span that has no bucket, it will silently never appear.** It won't error —
the packer just falls back to a quarter note and rests. This exact bug hid the ratio rhythms.

### The half-beat filler

Half a beat is exactly **half of a one-beat rhythm**, so the filler is built by slicing the bits of the
variations the user actually switched on — never a hardcoded run. `halfBeatPatterns()` takes each active
variation of the right bit-length, cuts it down the middle, and turns each half into notes with the
bank's own `bitsToNotes`, so sustains and un-notatable lengths follow §3 like everywhere else. A half
with no attack in it is silence, not a filler.

| Family | Bits per beat | One half is |
|---|---|---|
| 8th notes | 2 | one 8th |
| 16ths | 4 | two 16ths |
| Sextuplets | 6 | a 16th triplet (bracketed, `_subGroup` keeps it off the figure's bracket) |
| **32nds** | **8** | **four 32nds** |

Rules that apply to every filler:

- **It obeys Sparsity.** At 0 only a fully-struck half is legal, at 100 only a single note.
- **It can lead or follow** the figure, 50/50.
- **Nothing deselected may be invented.** If no active variation yields a legal half, the leftover is a
  **rest** — never a default note value. (32nds have no fallback at all for this reason; the older 8th
  and 16th branches keep one only because they predate the rule.)
- **Sticking follows the grid it was cut from**, not the note values. Two 16ths sliced out of a 32nd
  variation (`1010`) sit on partials 0 and 2 of a *32nd* grid, so they share a hand — read as plain
  16ths they would wrongly alternate. `_fillerSlots` carries that grid on the notes.

When building a mixed tile (figure + filler), the tuplet config must be copied onto the **notes** as
`_mixedTuplet`, plus `_mixedTupletDur` for the group's own length. `pickRandomStrict()` hangs `_tuplet`
off the *array*, so spreading it into a new tile silently drops the bracket.

---

## 11. Checklist for a new family

1. Decide **N** (notes) and **span** (beats). Confirm a bucket exists for that span — §10.
2. Pick the base note value by **speed** — §5.
3. Generate bits: all patterns if N ≤ 4, else `curateBits(N, maxK)` — §4.
4. Let `bitsToNotes()` derive the notes. Never hand-write durations.
5. Attach `_tuplet` with the correct `notes_occupied` — §8.
6. Register in `CATEGORIES` with a label that states the note value if the ratio is ambiguous
   (e.g. `"4:3 (16ths)"` vs `"4:3 (8ths)"`).
7. Add the picker tile in **`app.js`** — it is hand-drawn and does **not** follow the generator.
8. Run **`node chk-tiles.js`** to confirm the tile matches the generator.
9. Render it: `node dev/sr-shot.js <key> 4/4` and look at the notation.
10. `npm run sync-tools && node scripts/upload-tools.mjs` — the app reads tool code from the vault, not
    from the build. Skipping this is why a fix can look like it did nothing.
