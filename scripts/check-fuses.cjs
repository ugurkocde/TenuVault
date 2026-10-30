const { getCurrentFuseWire, FuseV1Options, FuseState } = require('@electron/fuses')
const app = process.argv[2]
if (!app) {
  console.error('Usage: node scripts/check-fuses.cjs <path-to-electron-binary>')
  process.exit(1)
}
const expected = {
  RunAsNode: FuseState.DISABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
  // Enabled on purpose: the renderer loads over file:// in the packaged app.
  // Asserted so the state is a recorded decision, not an overlooked default.
  GrantFileProtocolExtraPrivileges: FuseState.ENABLE,
}
getCurrentFuseWire(app).then(wire => {
  for (const [name, value] of Object.entries(expected)) {
    if (wire[FuseV1Options[name]] !== value) throw new Error(`Unexpected fuse: ${name}`)
  }
  console.log('All six security fuses verified')
}).catch(error => { console.error(error); process.exitCode = 1 })
