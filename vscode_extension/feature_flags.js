'use strict';

// Set this to false before packaging a Rust-only VSIX. The extension uses this
// value both at activation time and as a VS Code context key, so C commands,
// menus and editor actions stay hidden when the feature is disabled.
const C_LANGUAGE_SUPPORT = true;

module.exports = Object.freeze({
  cLanguageSupport: C_LANGUAGE_SUPPORT
});
