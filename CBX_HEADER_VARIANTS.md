# .chitubox header layout

Findings from 161 files (`R:\3dprintstuff`, `S:\mini-stls`, sample folder),
written after "Lance, head, small shields.chitubox" crashed the parser with
`RangeError: Offset is outside the bounds of the DataView`.

**The format is versioned, not variant-ridden.** An earlier revision of this
document described three "variants"; that was wrong, and the correction is the
main content here.

## The header is length-prefixed

`field12` (offset 12) is the **header length**. The mesh-section pointer and the
record-table delta live at fixed offsets *inside* that header, so their absolute
addresses move when the header size changes:

| Field | Location | Meaning |
|-------|----------|---------|
| `magic` | 0 | `0xAB231243` |
| `nInstances` | 4 | model instance / record count |
| `field8` | 8 | precomputed absolute offset of the record table |
| `field12` | 12 | **header length** (412, 420, or 0) |
| `field16` | 16 | previous header length, when the header has grown |
| `field20` | 20 | table end = `field8 + nInstances * 680` |
| `tableDelta` | **`field12 + 8`** | record table = `meshOffset + tableDelta` |
| `meshOffset` | **`field12 + 12`** | mesh section pointer |

Verified across the corpus:

```
meshOffset@(field12+12) + tableDelta@(field12+8) == field8    160 / 161 files
field8 points at a valid record table                          161 / 161 files
```

The record table is `nInstances` records of 680 bytes: a 256-byte NUL-padded
filename, then a 28-byte tail at `record + 256`.

## Header sizes seen

| `field12` | Files | Notes |
|-----------|-------|-------|
| 412 | 159 | the common writer; `meshOffset` @424, delta @420 |
| 420 | 1 | newer writer, header grew 8 bytes; `field16` = 412 records the old size |
| 0 | 1 | no length field; table at a flat 412 (`Chapter_Master_Hammer.chitubox`) |

`tableDelta` is **not** constant even at one header size: 444 in most files, 428
in `Cisne origami.chitubox`. Both are authored values, correctly read from
`field12 + 8`.

## What actually broke on Lance

`field12` = 420, so every pointer sat 8 bytes later than the parser assumed.
Reading byte 424 returned `2013` — a different field entirely, not a corrupt
`meshOffset`. That value passed a naive range check, so `meshOffset + 720`
decoded as a 1.3-billion triangle byte count, `modelStart` became
`-1280257320`, and the Z-offset scan read outside the DataView.

The real `meshOffset` is at `420 + 12 = 432` and reads `831348`. Adding the
authored delta at `420 + 8 = 428` (452) gives `831800`: the record table,
exactly. Nothing about the file is unusual once the header length is honoured.

## The support block is self-describing too

Each instance's support pointer addresses a small block header, which carries
the parametric record address at **`supPtr + 4`** and the record count at
`supPtr + 0`:

```
u32 @ supPtr+4 lands on the 0xEA342389 TAG    181 / 181 blocks
u32 @ supPtr+0 equals the TAG record count    180 / 181 blocks
```

The previously hardcoded `INLINE_PAD` of 436 is just what that pointer resolves
to under a 412-byte header; it is 416 under a 420-byte one. Same class of
mistake as the header offsets, one level down.

## Corrections to the earlier revision

- **"Variant B — shifted table" does not exist.** `Cisne origami` authors a
  delta of 428. There was no shift, only an unread field, which the +/-128
  nearby probe had been silently absorbing.
- **"Variant C" is not a dialect**, just a longer header.
- **`meshOffset` was never unreliable.** It was read from the wrong address.

## Remaining unknowns

- `Chapter_Master_Hammer.chitubox` has `field12 = 0` and an unusable
  `meshOffset`; its table sits at a flat 412 and is found via `field8`. Probably
  predates the length field. One specimen.
- The 420-byte header rests on **one file**. Broad coverage shows the common
  path is not regressed; it does not prove this path generalises.
- `Cisne origami.chitubox` parses to zero supports on every build tested. Not
  investigated — it may genuinely have none.
- One support block's count field disagrees with its TAG run; the parser counts
  the run, so this is not load-bearing.

## Reproducing

```
npx tsx scanCorpus.ts [--quiet] <dir> [dir...]
```

Exits non-zero if any file fails to parse. Current status: 161/161 parse, and
still 161/161 with the `field8` fast path disabled, confirming the header
arithmetic stands on its own.
