/**
 * What the release step of the paid key check (license.mjs --release) does with the kept
 * profile. The profile is removed only after a confirmed release, or when it holds nothing to
 * release. When the release did not succeed the profile stays, so the activation is not
 * forgotten, and the step fails, so the leftover is visible.
 */
export async function releaseLeftover({ empty, release, close, remove }) {
  if (empty()) {
    console.log("Nothing to release: the profile is empty.")
    remove()
    return "nothing"
  }
  let released = false
  try {
    released = (await release()) === true
  } catch {
    released = false
  } finally {
    await close()
  }
  if (!released) {
    throw new Error("The leftover activation could not be released. The profile is kept, and the activation stays held until it is released or the licensing service frees it.")
  }
  remove()
  return "released"
}
