import * as THREE from 'three';
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';
import { CbxParser } from './CbxParser';
import { CbxConverter, computeRaftZ, type CbxModelInput } from './CbxConverter';
import { createDefaultSettings } from '@/supports/Settings/types';
import { generateUuid } from '@/utils/uuid';

/**
 * File-type import bridge for `.chitubox` project files.
 *
 * Provides a non-React async import path used by the plugin file-type capability,
 * mirroring the LYS import bridge. Unlike LYS — which discovers scene objects and
 * assigns supports to owners heuristically at runtime — the Cbx parser already
 * returns geometry grouped per distinct model with its supports attached
 * (see CbxParser `models[]`, derived from the format report's block→geo mapping).
 * That makes this bridge simpler: iterate the parser's models, convert each.
 *
 * Placement/orientation policy (per format capability):
 *   - Plate XY position is now decoded from the per-instance header table
 *     (+660/+664) and applied: each model and its supports are translated onto
 *     their authored plate position, so multi-model imports spread across the
 *     plate instead of stacking at the origin.
 *   - Per-model rotation still lives in an undecoded region, so rotation is left
 *     identity. Inline geometry is already in print-plate orientation.
 *   - The decoded Z offset is applied so models/supports sit on the build plate
 *     (world Z = 0).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured result from importing one model out of a `.chitubox` container.
 * Shape matches the LYS import payload so the host scene manager can consume
 * both via the same code path.
 */
export type CbxImportPayload = {
  modelId: string;
  /**
   * Display name for this model, derived from the per-model filename stored in
   * the .chitubox container (extension stripped). The host scene manager uses
   * this to label the imported object; without it the host falls back to the
   * project filename plus a numeric suffix (e.g. "guns (2)").
   */
  name: string;
  geometry: THREE.BufferGeometry;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
  /** DragonFruit internal support format, ready for `loadFromImportFormat`. */
  supportData: ReturnType<typeof CbxConverter.convert> | null;
};

// ---------------------------------------------------------------------------
// Diagnostics helper
// ---------------------------------------------------------------------------

function summarizeImportSupportData(
  importData: ReturnType<typeof CbxConverter.convert> | null | undefined,
) {
  if (!importData) {
    return {
      roots: 0,
      trunks: 0,
      branches: 0,
      leaves: 0,
      twigs: 0,
      sticks: 0,
      braces: 0,
      knots: 0,
      kickstands: 0,
    };
  }
  return {
    roots: importData.roots?.length ?? 0,
    trunks: importData.trunks?.length ?? 0,
    branches: importData.branches?.length ?? 0,
    leaves: importData.leaves?.length ?? 0,
    twigs: importData.twigs?.length ?? 0,
    sticks: importData.sticks?.length ?? 0,
    braces: importData.braces?.length ?? 0,
    knots: importData.knots?.length ?? 0,
    kickstands: importData.kickstands?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-model conversion
// ---------------------------------------------------------------------------

/**
 * Convert one parsed Cbx model (geometry + its supports) into a payload.
 *
 * The parser delivers geometry already in world space (Z offset applied per the
 * format report's coordinate handling) plus the authored plate transform. The
 * model is placed at its plate XY (header +660/+664) with the support cluster
 * shifted to match, and lifted in Z so its supported surface meets the contact
 * cones. Rotation is identity (per-model rotation is not yet decoded).
 */
function convertSingleModel(
  model: CbxModelInput,
  settings: ReturnType<typeof createDefaultSettings>,
): CbxImportPayload {
  const importedModelId = generateUuid();

  // CbxModelInput.geometry is typed optional; the parser always supplies
  // one, but guard here so the payload's geometry is always a real (possibly
  // empty) BufferGeometry rather than null/undefined.
  const geometry = model.geometry ?? new THREE.BufferGeometry();

  console.log('[chitubox-import][debug] convertSingleModel:start', {
    modelIndex: model.index,
    filename: model.filename,
    supportCount: model.supports.length,
    geometryVertexCount: geometry.getAttribute('position')?.count ?? 0,
    importedModelId,
  });

  // Build a raycast mesh from the model geometry so createContactAssembly can
  // recover the true surface normal at each contact point (better cone seating
  // on angled faces). Double-sided basic material; matrix world updated; the
  // material is disposed after conversion. Mirrors the LYS ghost-mesh approach.
  let raycastMesh: THREE.Mesh | undefined;
  let ghostMaterial: THREE.Material | undefined;
  if (geometry.getAttribute('position')?.count) {
    ghostMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    raycastMesh = new THREE.Mesh(geometry, ghostMaterial);
    raycastMesh.updateMatrixWorld(true);
  }

  let dragonfruitData = CbxConverter.convert(model, settings, raycastMesh);
  if (dragonfruitData) {
    CbxConverter.reassignModelId(dragonfruitData, importedModelId);
  }

  if (ghostMaterial) ghostMaterial.dispose();

  // --- Placement: keep the authored world frame, seat roots on the plate ------
  //
  // Chitubox authors model geometry and supports in ONE consistent world frame:
  // support roots on the raft (~1mm), tips at the model surface, model geometry
  // bottom at that same surface. We keep that frame intact (so model↔support
  // alignment is preserved exactly) and apply a single uniform Z shift to the
  // supports so the lowest support point (the roots, at the raft top) sits on the
  // build plate at z=0. The geometry stays in world coordinates; the host anchors
  // it to the same frame as the supports, so the whole assembly lands together.
  //
  // This replaces an earlier bbox-center shift that dragged the whole (correctly
  // aligned) assembly far below the plate.
  let modelLiftZ = 0;
  // Authored plate position (header +660/+664). Absent on the anomalous last
  // entry → defaults to origin. The model and its supports share one local
  // frame, so we translate BOTH by this amount to spread models across the
  // plate while keeping each model locked to its own supports.
  const plateX = model.transform?.plateX ?? 0;
  const plateY = model.transform?.plateY ?? 0;

  // raftZ is the support cluster's plate offset (0 when there are no supports).
  const raftZ = computeRaftZ(model.supports ?? []);

  // Model lift. Chitubox stores the model's intended bottom height above the plate
  // in the per-instance liftZ field: supported models get liftZ = raft gap (e.g.
  // 5mm), and support-less models get liftZ = 0 (flat on the bed). The host centers
  // the geometry's bbox at z=0 then applies this lift, so to land the model bottom
  // at liftZ we add half the model height:
  //
  //   modelLiftZ = liftZ + halfHeight   →   model bottom = liftZ
  //
  // For SUPPORTED models this is identical to the old "bboxCenterZ - raftZ" form
  // (because rawBottom - raftZ == liftZ for every supported instance), so the model
  // stays locked to its supports. For SUPPORT-LESS models the old form leaked the
  // geometry's raw authored Z (leaving them floating 4–26mm off the plate); using
  // liftZ instead grounds them flat on the bed, matching Chitubox.
  const liftZ = model.transform?.liftZ ?? 0;
  let halfHeight = 0;
  if (geometry.getAttribute('position')?.count) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) halfHeight = (box.max.z - box.min.z) / 2;
  }
  modelLiftZ = liftZ + halfHeight;

  if (dragonfruitData) {
    CbxConverter.applyZShift(dragonfruitData, -raftZ);
    // Move the support cluster from model-local XY onto its plate position.
    CbxConverter.applyXYShift(dragonfruitData, plateX, plateY);
    // The supports now sit correctly: roots on the plate (z=0), cones up at the
    // model surface; the model lift above keeps geometry and supports in one frame
    // so pulling the model in the host drags its supports with it.
  }

  // Plate XY for the MODEL transform. The host centers the geometry's bbox at
  // transform.position, so to land the model over its (XY-shifted) supports we
  // add the bbox-center XY to plateXY — the same centering-cancellation the Z
  // term does with +halfHeight. With no geometry, plateXY alone is used.
  let centerX = 0;
  let centerY = 0;
  if (geometry.getAttribute('position')?.count) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) {
      centerX = (box.max.x + box.min.x) / 2;
      centerY = (box.max.y + box.min.y) / 2;
    }
  }

  const transform = {
    position: new THREE.Vector3(plateX + centerX, plateY + centerY, modelLiftZ),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };

  console.log('[chitubox-import][debug] convertSingleModel:done', {
    modelIndex: model.index,
    importedModelId,
    supportSummary: summarizeImportSupportData(dragonfruitData),
  });

  return {
    modelId: importedModelId,
    name: deriveModelName(model.filename, model.index),
    geometry,
    transform,
    supportData: dragonfruitData,
  };
}

/**
 * Build a display name for an imported model from its container filename.
 * Strips a trailing 3D-model extension (.stl/.obj/.ply/.3mf) so the host shows
 * "Turret_Ammo_Hollowed" rather than "Turret_Ammo_Hollowed.stl". Falls back to
 * an indexed generic name when the container has no filename for this instance.
 */
function deriveModelName(filename: string | null | undefined, index: number): string {
  const raw = (filename ?? '').trim();
  if (!raw) return `model_${index + 1}`;
  return raw.replace(/\.(stl|obj|ply|3mf)$/i, '');
}

// ---------------------------------------------------------------------------
// Core import function (plain async — no React state)
// ---------------------------------------------------------------------------

export async function importCbxFile(
  file: File,
): Promise<CbxImportPayload | CbxImportPayload[]> {
  console.log('[chitubox-import] Starting Cbx import...');
  const parsed = await CbxParser.parse(file);

  const settings = createDefaultSettings();
  const models = parsed.models ?? [];

  console.log('[chitubox-import][debug] container summary', {
    instanceCount: parsed.instanceCount,
    distinctModels: models.length,
    zOffset: parsed.zOffset,
    modelFilenames: models.map((m) => m.filename),
  });

  if (models.length === 0) {
    console.warn('[chitubox-import] No model geometry found in container');
    // Best-effort empty payload so the importer can surface a clean state.
    return {
      modelId: generateUuid(),
      name: 'model_1',
      geometry: new THREE.BufferGeometry(),
      transform: {
        position: new THREE.Vector3(0, 0, 0),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1),
      },
      supportData: null,
    };
  }

  // -----------------------------------------------------------------------
  // Multi-model path: each distinct model gets an independent payload.
  // -----------------------------------------------------------------------
  if (models.length > 1) {
    console.log('[chitubox-import][debug] entering multi-model import path', {
      modelCount: models.length,
    });

    const payloads = models.map((model) => convertSingleModel(model, settings));

    console.log('[chitubox-import][debug] multi-model payloads generated', {
      payloadCount: payloads.length,
      modelIds: payloads.map((p) => p.modelId),
      supportSummaries: payloads.map((p) => ({
        modelId: p.modelId,
        ...summarizeImportSupportData(p.supportData),
      })),
    });

    return payloads;
  }

  // -----------------------------------------------------------------------
  // Single-model path.
  // -----------------------------------------------------------------------
  console.log('[chitubox-import][debug] entering single-model import path');
  const payload = convertSingleModel(models[0], settings);

  console.log('[chitubox-import][debug] single-model payload generated', {
    modelId: payload.modelId,
    supportSummary: summarizeImportSupportData(payload.supportData),
  });

  return payload;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Plugin file-type handler (required export for fileType capability)
// ---------------------------------------------------------------------------

export const handleFileTypeImport: PluginFileTypeHandler = async (
  file: File,
  _fileTypeDefinition: PluginFileTypeDefinition,
) => {
  try {
    const result = await importCbxFile(file);
    return { success: true, payload: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[chitubox-import] Import failed:', err);
    return { success: false, error: message };
  }
};
