# .chitubox container format

Derived from 161 files (`R:\3dprintstuff`, `S:\mini-stls`, and the sample
folder), after "Lance, head, small shields.chitubox" crashed the parser with
`RangeError: Offset is outside the bounds of the DataView`.

**There is one format, not a family of variants.** Earlier revisions of this
document catalogued two and then three "variants"; both were wrong, and were
artefacts of reading fields from hardcoded addresses. The correction is the
substance of this document.

## Fixed header

Little-endian throughout. The first 412 bytes are almost entirely zero — only
four fields are used.

| Offset | Name | Meaning |
|--------|------|---------|
| 0 | `magic` | `0xAB231243` |
| 4 | `nInstances` | model instance count = record-table length |
| 8 | `field8` | precomputed absolute offset of the record table |
| 12 | `field12` | base offset of the pointer block (see below) |

## Pointer block

`field12` is **a base offset, not a header length**. A small block of pointers
begins there:

| Offset | Meaning |
|--------|---------|
| `field12 + 0` | preview image width |
| `field12 + 4` | preview image height |
| `field12 + 8` | `tableDelta` |
| `field12 + 12` | `meshOffset` |

The record table is then:

```
table = meshOffset + tableDelta      ( == field8 )
```

Verified in **161 of 161 files**, with no clamping and no fallbacks. `field8`
carries the same address precomputed; the corpus still parses 161/161 with the
`field8` fast path disabled, so the arithmetic stands on its own.

### Why the old code broke

The parser previously read `meshOffset` at a hardcoded 424 and used a fixed
delta of 444 — correct only when `field12 == 412`. Three consequences:

- **`field12 == 420`** (one file, a newer writer that moved the block; it
  records the old base in `field16` and the table end in `field20`). Byte 424
  is then a *different field*, which read as `2013`. That passed a naive range
  check, so `meshOffset + 720` decoded as a 1.3-billion triangle byte count,
  `modelStart` became `-1280257320`, and the Z-offset scan read outside the
  DataView. The real `meshOffset` is at 432 and reads `831348`; adding the
  authored delta at 428 (452) gives `831800` — the table, exactly.
- **`tableDelta` is not always 444.** `Cisne origami.chitubox` authors 428.
  There was never a "shifted table" variant, only an unread field, which the
  ±128 nearby probe had been silently absorbing.
- **`field12 == 0`** (one file, no mesh section). The pointer block then lands
  on offsets 8 and 12, giving `meshOffset = 0` and `delta = 412`, so the table
  begins immediately after the fixed header. Consistent with the same rule.

`field12` values seen: **0, 412, 420**.

## Record table

`nInstances` entries of **680 bytes**:

| Offset in record | Meaning |
|------------------|---------|
| 0 | filename, 256 bytes, NUL-padded |
| 256 + 0 | f32 plate X |
| 256 + 4 | f32 plate Y |
| 256 + 8 | f32 Z-lift (5.0 supported, 0.0 flat on plate) |
| 256 + 12 | `supPtr` — support block, or `0xFFFFFFFF` for none |
| 256 + 16 | geometry start offset |
| 256 + 20 | geometry byte count (triangles = bytes / 36) |
| 256 + 26 | terminator `0x4E 0xFF` |

## Support block

`supPtr` addresses a small block header, which is **self-describing**:

| Offset | Meaning |
|--------|---------|
| `supPtr + 0` | allocated record slots |
| `supPtr + 4` | absolute offset of the first parametric record |

`supPtr + 4` lands on a `0xEA342389` TAG in **181 of 181 blocks**. The
previously hardcoded `INLINE_PAD` of 436 is just what that pointer resolves to
under a 412-byte pointer-block base; it is 416 when the base is 420. The pad was
never a constant — the same class of mistake as the header offsets, one level
down.

`supPtr + 0` is the **allocated** count, not the used one: `10.chitubox`
declares 337 and writes 329, leaving eight zeroed slots. The parser therefore
counts the contiguous TAG run rather than trusting the field.

Parametric records are 72 bytes each, contiguous from that pointer.

## Byte coverage

`guns.chitubox`, 15,837,356 bytes, fully accounted for:

| Region | Bytes | Share |
|--------|-------|-------|
| model geometry | 8,498,052 | 53.66% |
| baked support mesh | 7,182,864 | 45.35% |
| support records | 92,592 | 0.58% |
| preview image | 53,760 | 0.34% |
| record table | 7,480 | 0.05% |
| support block headers | 2,180 | 0.01% |
| fixed header | 412 | — |
| pointer block | 16 | — |
| **unaccounted** | **0** | — |

Two regions are identified but not decoded:

- **Baked support mesh** (~45%). Between each model's support records and its
  geometry: a triangle soup Chitubox pre-tessellates from the parametric
  records. Every supported model has one; unsupported models do not. We rebuild
  supports from the records instead, so this is redundant for import — but it
  explains the file sizes.
- **Preview image** (~0.34%). `field12 + 0/+4` give its dimensions (400×300 in
  `guns.chitubox`). At 0.44 bytes per pixel it is RLE-compressed RGB565. Not
  decoded; cosmetic.

## Not this format

`cube_export1_unsupported - Copy.chitubox` carries magic `0xAB231253` — one
nibble different — and is rejected at the magic check. A different container
that happens to share the extension.

## Testing

```
npx tsx --test CbxParser.test.ts CbxLayout.test.ts
npx tsx scanCorpus.ts [--quiet] <dir> [dir...]
```

Both suites reach further when pointed at real files, and skip cleanly without
them so the plugin stays green on a bare checkout:

```
CBX_CORPUS="R:/3dprintstuff;S:/mini-stls;R:/allancodejunk/dfwork/chitubox-sample-files" \
CBX_FIXTURES="R:/allancodejunk/techno sun goddess" \
  npx tsx --test CbxParser.test.ts CbxLayout.test.ts
```

- `CbxParser.test.ts` — synthetic chain fixtures, plus a real-file regression
  against `SPOTLIGHT.chitubox` (7 supports, 8 tips, verified reconstruction).
  That fixture is a 3.8 MB binary and is not committed; `CBX_FIXTURES` locates
  it.
- `CbxLayout.test.ts` — the invariants above, over every file under
  `CBX_CORPUS`.
- `scanCorpus.ts` — runs the parser end to end, exits non-zero on any failure.

Current status: **18/18 tests pass** with corpus and fixture present (9 layout
invariants over 161 files and 189 model records, 9 parser tests), and
**161/161 files parse**.

Note that the parent repo's `npm test` globs `src/**` only, so none of these run
in CI today.

## Caveats

- The `field12 == 420` and `field12 == 0` cases rest on **one file each**. Broad
  coverage shows the common path is not regressed; it does not prove those paths
  generalise.
- `Cisne origami.chitubox` parses to zero supports on every build tested. Not
  investigated — it may genuinely have none.
- `SPOTLIGHT.chitubox`, the fixture behind the real-file regression test in
  `CbxParser.test.ts`, is absent from the repo, so that test skips.
