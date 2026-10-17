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
    version: '0.1.4',
    description: 'Imports .chitubox and .ctp project files into DragonFruit',
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
    {
      fileExtension: '.ctp',
      mimeType: 'application/octet-stream',
      displayName: 'CTP Project',
      isSceneFile: true,
      importWarning: {
        title: 'Chitubox Pro Import',
        body: 'CTP import converts Chitubox Pro project data into DragonFruit format. Support placement may differ from the original scene.',
        storageKey: 'dragonfruit.ctpImportWarningDismissed',
      },
    },
  ],
  sceneOverlayLoader: () =>
    import('./GhostOverlay').then((module) => ({ default: module.GhostOverlay })),
};

export default PLUGIN_DEFINITION;
