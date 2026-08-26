// @oldbulb/samsara-workbench — the host-plane rows and the operator preset
// that turn a dsh-web-app host into a samsara workbench. The entry is the
// tools row (`./tools`, mounted inside the operator preset); the executor,
// the commands, the notebook, the startup reconciliation and the preset
// installer are the package's other subpaths, each a row of its own.

export * from './tools.ts'
