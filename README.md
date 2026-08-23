# Chitubox Import Plugin (`chitubox-import`)

Built-in DragonFruit plugin for importing `.chitubox` project files and converting their model geometry and support data into DragonFruit's internal format.

## What this plugin does

- Parses `.chitubox` containers and their per-instance model table.
- Reads model geometry (flat 36-byte triangles) for each model instance.
- Decodes the parametric support records and rebuilds them as editable DragonFruit primitives (roots, trunks, knots, contact cones, braces).
- Converts supports into DragonFruit's import format (`DragonfruitImportFormat`).
- Applies per-model transform alignment (plate XY + authored lift) so models and supports land correctly on the build plate.
- Threads each model's authored filename through as its display name.

## Scope and expectations

- This plugin is designed for **practical project import compatibility**.
- Imported support topology may differ slightly from the authoring app after conversion (Chitubox and DragonFruit use different support methodologies).
- Encrypted / protected container regions are left untouched; only the model and support tables are read.
- Missing or malformed records are handled with best-effort fallbacks where possible.

## Key files

- `pluginDefinition.ts` — plugin manifest + file type registration.
- `fileTypeHandlers.ts` — project-file import bridge used by the host file importer; handles model placement, model naming, and single/multi-model payloads.
- `CbxParser.ts` — container parsing, per-instance model table decode, geometry decode, and parametric support-record reconstruction.
- `CbxConverter.ts` — conversion into DragonFruit support primitives (roots/trunks/knots/contact cones/braces) and model-id reassignment.
- `converter/contactAssembly.ts` — contact-cone + socket construction shared with the support build path.
- `converter/supportGraph.ts` — builds the endpoint graph the reconstruction runs on.
- `converter/graphClassify.ts` — labels each connected component (brace, twig, stick, fan, tree…).
- `converter/graphEmit.ts` — emits DragonFruit supports from the classified graph.
- `tools/` — CLI helpers for corpus scanning and builder comparison; never imported by the plugin.
- `GhostOverlay.tsx` — optional debug overlay for inspecting parsed support geometry.

## Container format note

`.chitubox` files store model instances in a fixed-stride per-instance table (filename + plate transform + geometry pointers + support pointer). Support geometry is a list of tagged 72-byte parametric records, each typed by a sub-index:

- `1` — contact tip (model-contacting cone; may be slanted)
- `2` — model header (skipped)
- `3` — vertical pillar shaft, or a diagonal brace (shaft-to-shaft strut)
- `4` — wide base pad cone
- `5` — flat ground-contact foot disk (marks the plate; sometimes clustered into a platform)
- `6` — summary record, skipped but unsure of it's purpose at the moment, rarely more than one in any file, some have none at all 
- `7` / `8` / `9` — spherical joint. Stored as a diameter segment: the two endpoints are opposite poles, so the joint sits at their midpoint.
- `12` — twig: a short strut joining one part of the model to another, for overhangs that cannot reach the plate.

Support reconstruction builds a graph rather than following record order: nodes are quantised record endpoints, edges are the shaft records (`1`, `2`, `3`, `12`), and spheres decorate the nodes they surround. Roles then fall out of the graph's shape — a pillar is a maximal run of vertical `sub-3` edges, a brace is a diagonal one, and a contact attaches to whichever pillar its authored socket lands on.

This matters because a support's role is **not** recorded in the file. The authoring app draws a brace and a structural pillar with identical geometry, and `sub` does not separate them, so the distinction has to be inferred from how the pieces connect.

## Geometry handling

- Reads each model instance's triangle region directly (`[geoStart, geoEnd)`), one clean read per model.
- Uses flat-shaded non-indexed geometry for STL-like visual consistency.
- Multi-instance files yield one independent payload per model; reoriented duplicates that carry no Chitubox supports are placed at their authored height.

## Legal notice (interoperability)

This plugin includes format-compatibility work for `.chitubox` project files to enable interoperability between software ecosystems.

The project is developed in good faith for compatibility use cases, with attention to applicable legal frameworks such as:

- EU Directive 2009/24/EC (interoperability-related reverse engineering allowances)
- DMCA Section 1201(f) (United States interoperability exemption)
- Fair Use / Fair Dealing doctrines where applicable

The implementation follows clean-room style engineering practices for independent behavior verification and format compatibility.

Users are responsible for ensuring their use complies with applicable law in their jurisdiction.

**Disclaimer:** This section is general information only and does not constitute legal advice. For jurisdiction-specific guidance, consult qualified legal counsel.

## Logging and diagnostics

The plugin intentionally emits detailed import diagnostics (`[CbxParser]`, `[chitubox-import]`, `[CbxConverter]`) for troubleshooting unsupported variants.

If import fails, capture logs around:

- per-instance model table decode (instance count, model filenames)
- geometry region read (vertex counts)
- support-record reconstruction (support / brace / contactless-pillar counts)

## Development tools

CLI helpers live in `tools/` and are never imported by the plugin itself.

```
npx tsx tools/scanCorpus.ts [--quiet] <dir> [dir...]
```

Parses every `.chitubox` file under the given roots and reports failures, exiting
non-zero if any file fails. Run this after any parser change — it is the check that
catches a fix for one file breaking nine others.

```
npx tsx tools/compareGraph.ts <file.chitubox> [--verbose]
npx tsx tools/corpusCompare.ts <dir> [dir...]
```

Compare the graph reconstruction against the previous chain builder, per support
rather than by totals. The chain builder is still reachable by setting
`CBX_CHAIN_BUILDER=1`, so the two can be diffed across a corpus.

## Tests

```
npx tsx --test CbxParser.test.ts
CBX_CORPUS="/path/to/corpus" npx tsx --test CbxLayout.test.ts
```

`CbxParser.test.ts` runs from a synthetic fixture and needs nothing external.
`CbxLayout.test.ts` asserts container invariants against real files and **skips**
unless `CBX_CORPUS` names one or more directories; `CBX_FIXTURES` likewise points the
parser regression test at real files. No corpus is committed, and absence skips
rather than fails, so a clean checkout passes.

## Maintenance notes

- Keep terminology neutral and compatibility-focused (`decode container`, `import compatibility`) rather than reverse-engineering language.
- Keep parser and converter changes paired with focused tests when behavior changes.
- Validate against real `.chitubox` files at each step; the support reconstruction is sensitive to the per-instance table stride and field offsets.
