const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
// Fuse wire states are ASCII '0' (disabled) and '1' (enabled).
const disabled = '0'.charCodeAt(0)
const enabled = '1'.charCodeAt(0)
const app = process.argv[2]
if (!app) {
  console.error('Usage: node scripts/check-fuses.cjs <path-to-electron-binary>')
  process.exit(1)
}
const expected = {
  RunAsNode: disabled,
  EnableNodeOptionsEnvironmentVariable: disabled,
  EnableNodeCliInspectArguments: disabled,
  EnableEmbeddedAsarIntegrityValidation: enabled,
  OnlyLoadAppFromAsar: enabled,
}
getCurrentFuseWire(app).then(wire => {
  for (const [name, value] of Object.entries(expected)) {
    if (wire[FuseV1Options[name]] !== value) throw new Error(`Unexpected fuse: ${name}`)
  }
  console.log('All five security fuses verified')
}).catch(error => { console.error(error); process.exitCode = 1 })
