import type { ComplexPluginDefinition } from '@/features/plugins/complexPluginContracts';

/**
 * Built-in plugin descriptor for DragonFruit's Chitubox project-file import capability.
 *
 * Mirrors the LYS import plugin's descriptor shape (ComplexPluginDefinition):
 * - File-type focused (no runtime protocol / encoder / network surface).
 * - The import warning sets compatibility expectations before import, since
 *   support topology may differ slightly from the authoring app after conversion.
 *
 * Format notes (see chitubox_format_report.md for the full spec):
 * - `.chitubox` is a proprietary little-endian binary project file.
 * - Model geometry is stored as compact float32 triangles; supports are
 *   parametric records. Only the support-settings UI header is undecoded and is
 *   not required for import.
 * - Plate XY position is decoded from the per-instance header table and applied
 *   at import; per-model rotation remains undecoded, so models import at their
 *   authored plate position with identity rotation. The support-settings UI
 *   header is undecoded and not required for import.
 */
const PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: 'chitubox-import',
  manifest: {
    id: 'chitubox-import-builtin',
    name: 'Chitubox File Support',
    version: '0.1.0',
    description: 'Imports .chitubox project files into DragonFruit',
    author: 'Open Resin Alliance',
    homepage: 'https://github.com/Open-Resin-Alliance/df-plugin-chitubox',
  },
  capabilities: {
    networkOperations: false,
    uploadWithProgress: false,
    slicerEncoder: false,
    tauriRuntimePlugin: false,
    fileType: true,
  },
  fileTypes: [
    {
      fileExtension: '.chitubox',
      mimeType: 'application/octet-stream',
      displayName: 'CBX Project',
      isSceneFile: true,
      importWarning: {
        title: 'Chitubox Import',
        body: 'Chitubox import converts Chitubox project data into DragonFruit format. Support placement may differ from the original scene.',
        storageKey: 'dragonfruit.chituboxImportWarningDismissed',
      },
    },
  ],
  sceneOverlayLoader: () =>
    import('./GhostOverlay').then((module) => ({ default: module.GhostOverlay })),
};

export default PLUGIN_DEFINITION;
