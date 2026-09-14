'use strict';

const { createRustEntityPackageManager } = require('./rust_entity_packages');

const manager = createRustEntityPackageManager({
  repositorySetting: 'rustBoardPackagesRepository',
  legacyRepositorySetting: 'rustBspPackagesRepository',
  releaseTag: 'rust-board-packages',
  catalogAsset: 'rust_board_packages.json',
  packagesRootName: 'rust-board-packages',
  catalogCacheName: '.rust-board-packages-catalog.json',
  packageMarker: '.rust-board-package.json',
  installMarker: '.rust-board-installed.json',
  schemaVersion: 1,
  packageModel: 'board-entity',
  allowedEntityTypes: ['board', 'shield'],
  entityOrder: { board: 0, shield: 1, legacy: 2 },
  tempPrefix: 'rust-board',
  itemKind: 'rust-board-bsp',
  label: 'Rust Board BSP',
  cancellationLabel: 'Rust Board BSP package installation cancelled.',
  packageDetail(spec) {
    if (spec.entityType === 'board') {
      return `${spec.directMcuCount || 0} direct MCU(s), ${spec.cardCount || 0} MCU card(s), ${spec.shieldCount || 0} shield(s)`;
    }
    return `Shield used by ${spec.boardCount || 0} board(s)`;
  }
});

module.exports = {
  ...manager,
  ensureRustBoardPackage(context, uid, progress, token, options = {}) {
    return manager.ensureEntityPackage(context, 'board', uid, progress, token, options);
  },
  ensureRustShieldPackage(context, uid, progress, token, options = {}) {
    return manager.ensureEntityPackage(context, 'shield', uid, progress, token, options);
  }
};
