'use strict';

const { createRustEntityPackageManager } = require('./rust_entity_packages');

const manager = createRustEntityPackageManager({
  repositorySetting: 'rustCardPackagesRepository',
  legacyRepositorySetting: 'rustBspPackagesRepository',
  releaseTag: 'rust-card-packages',
  catalogAsset: 'rust_card_packages.json',
  packagesRootName: 'rust-card-packages',
  catalogCacheName: '.rust-card-packages-catalog.json',
  packageMarker: '.rust-card-package.json',
  installMarker: '.rust-card-installed.json',
  schemaVersion: 1,
  packageModel: 'card-entity',
  allowedEntityTypes: ['card'],
  entityOrder: { card: 0, legacy: 1 },
  tempPrefix: 'rust-card',
  itemKind: 'rust-card-bsp',
  label: 'Rust MCU Card BSP',
  cancellationLabel: 'Rust MCU Card BSP package installation cancelled.',
  packageDetail(spec) {
    return `${spec.mcuCount || 0} MCU(s), used by ${spec.boardCount || 0} board(s)`;
  }
});

module.exports = {
  ...manager,
  ensureRustCardPackage(context, uid, progress, token, options = {}) {
    return manager.ensureEntityPackage(context, 'card', uid, progress, token, options);
  }
};
