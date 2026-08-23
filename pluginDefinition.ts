import type { ComplexPluginDefinition } from '@/features/plugins/complexPluginContracts';

/**
 * Built-in plugin descriptor for DragonFruit's Chitubox project-file import capability.
 *
 */
const PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: 'chitubox-import',
  manifest: {
    id: 'chitubox-import-builtin',
    name: 'Chitubox File Support',
    version: '0.1.3',
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
        body: 'Chitubox import converts Chitubox project data into DragonFruit format. Support placement may differ from the original scene, and plate position/orientation are not recovered.',
        storageKey: 'dragonfruit.chituboxImportWarningDismissed',
      },
    },
  ],
  sceneOverlayLoader: () =>
    import('./GhostOverlay').then((module) => ({ default: module.GhostOverlay })),
};

export default PLUGIN_DEFINITION;
