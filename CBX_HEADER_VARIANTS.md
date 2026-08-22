# .chitubox header variants

Findings from parsing 161 files (`R:\3dprintstuff`, `S:\mini-stls`, and the
sample folder). Written after "Lance, head, small shields.chitubox" crashed the
parser with `RangeError: Offset is outside the bounds of the DataView`.

## Header fields

All offsets are from the start of the file, little-endian.

| Offset | Name here | Meaning |
|--------|-----------|---------|
| 0   | `magic`      | `0xAB231243` |
| 4   | `nInstances` | number of model instances (= record count) |
| 8   | `f8`         | **absolute offset of the record table** (first record's filename) |
| 12  | `f12`        | layout marker: `412`, `420`, or `0` |
| 16  | `f16`        | variant C only: `412` |
| 20  | `f20`        | variant C only: table end = `f8 + nInstances * 680` |
| 424 | `meshOffset` | mesh-section pointer; the table is at `meshOffset + 444` in variant A only |

The record table is `nInstances` records of **680 bytes**: a 256-byte
NUL-padded filename followed by a 28-byte tail at `record + 256`.

## The three variants

### A — common (158 / 161 files)

```
f12 = 412,  f16 = 0,  f20 = 0
meshOffset valid,  meshOffset + 444 == f8
```

Both pointers agree. `meshOffset + 720` holds the primary model's triangle byte
count, which locates the geometry section.

### B — shifted table (1 / 161: `Cisne origami.chitubox`)

```
f12 = 412,  f16 = 0,  f20 = 0
meshOffset valid,  meshOffset + 444 == f8 - 16
```

Header looks like variant A, but the table sits 16 bytes below where
`meshOffset + 444` predicts. The pre-existing nearby-shift probe already
absorbed this, logging `record table found at meshOffset+428 (expected +444)`.

### C — relocated table (1 / 161: `Lance, head, small shields.chitubox`)

```
f12 = 420,  f16 = 412,  f20 = f8 + nInstances * 680   (table end)
meshOffset present but NOT a table pointer
```

The distinguishing variant, and the one that crashed the parser. Differences
from A, all of which had to be handled:

1. **`meshOffset` is not a table pointer.** It read as `2013` while the table
   sat at `831800`. `meshOffset` still passes a naive range check, so the value
   at `meshOffset + 720` decoded as a 1.3-billion triangle byte count and drove
   `modelStart` to `-1280257320` — the source of the DataView crash.
2. **The table is far into the file.** 831800 is beyond both the ±128-byte
   nearby-shift probe and the 64 KB absolute scan, so neither fallback found it.
3. **Support block pad is 416, not 436.** The gap from an instance's support
   pointer to its first `0xEA342389` TAG record.
4. **`geoPtr` (TAG record + 40) is relative, not absolute.** `geoPtr - recBase`
   goes negative, so the block extent computed as zero records.

Points 3 and 4 each independently produce a *clean parse with zero supports* —
silent data loss rather than an error.

### Not a variant — different format

`cube_export1_unsupported - Copy.chitubox` carries magic `0xAB231253`
(one nibble different) and is rejected up front. Unrelated to the above.

## Why the parser now keys on `f8`

`f8` addresses a valid record table in **161 of 161 files**, including all three
variants. `meshOffset + 444` is correct in 158. `f8` is therefore the primary
pointer, with the `meshOffset + 444` probe kept as a fallback for any file where
`f8` is zero or out of range.

The support block is located by **seeking the TAG** rather than adding a fixed
pad, and the block extent falls back to **counting the TAG run** when `geoPtr`
cannot be a valid end marker. Both avoid keying on `f12`, so a fourth variant
with yet another pad or pointer convention should still parse.

## Caveats

- Variants B and C rest on **one file each**. Broad corpus coverage shows the
  common case is not regressed; it does not prove these paths generalise.
- `f12` correlates perfectly with the pad (412 → 436, 420 → 416) across this
  corpus, but the parser deliberately does not rely on that.
- `Cisne origami.chitubox` parses to zero supports on both the old and new
  parser. Whether it is genuinely unsupported or a further variant is unresolved.

## Reproducing

```
npx tsx scanCorpus.ts [--quiet] <dir> [dir...]
```

Exits non-zero if any file fails to parse.
