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
- `GhostOverlay.tsx` — optional debug overlay for inspecting parsed support geometry.

## Container format note

`.chitubox` files store model instances in a fixed-stride per-instance table (filename + plate transform + geometry pointers + support pointer). Support geometry is a list of tagged 72-byte parametric records, each typed by a sub-index:

- `1` — contact tip (model-contacting cone; may be slanted)
- `2` — model header (skipped)
- `3` — vertical pillar shaft, or a diagonal brace (shaft-to-shaft strut)
- `4` — wide base pad cone
- `5` — flat ground-contact foot disk (marks the plate; sometimes clustered into a platform)
- `6` — summary record, skipped but unsure of it's purpose at the moment, rarely more than one in any file, some have none at all 
- `9` — spherical knot joint atop a pillar
- `12` — small support for connecting one part of model to another (usually for hard to support overhangs) 

Some `sub-1` records connect two pillar shafts rather than the model; these are reclassified as braces, and the pillars they join are kept as contactless trunks.

'sub-12' records are not currently handled at all, and there are still some translation errors where supports that are intended as braces between other support trunks are translated as equivalent to 'sub-4' base cones.

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

## Maintenance notes

- Keep terminology neutral and compatibility-focused (`decode container`, `import compatibility`) rather than reverse-engineering language.
- Keep parser and converter changes paired with focused tests when behavior changes.
- Validate against real `.chitubox` files at each step; the support reconstruction is sensitive to the per-instance table stride and field offsets.
