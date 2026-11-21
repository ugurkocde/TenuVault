export async function checkOmission({ check, evaluate, restart, waitForText, waitForCondition, assert }) {
  const tenantId = "11111111-1111-1111-1111-111111111111"
  const backupId = "backup-2026-11-20-180000"
  const blocker = "Values were left out of this backup. Use a backup that includes them to restore this item."
  await check("omission survives an app restart and appears in comparison and restore preview", async () => {
    assert(!(await evaluate(`window.tenuvault.backups.omission("${tenantId}").then(policy => policy.enabled)`)), "omission was enabled by default")
    await evaluate(`window.tenuvault.backups.setOmission("${tenantId}", true, false)`)
    await restart()
    const policy = await evaluate(`window.tenuvault.backups.omission("${tenantId}")`)
    assert(policy.enabled && !policy.scripts, "the main-process setting did not survive restart")

    assert(await waitForCondition("Boolean(document.querySelector('aside'))"), "the application shell did not load after restart")

    // Deterministic backup data from a stand-in for the renderer's tenant routes. The setting and
    // restart above use the real preload and app store. Restore and compare routes are tested with
    // the same archive shape and a local blob store in backup-secret-omission.test.ts.
    await evaluate(`(() => {
      const original = window.fetch;
      const backupId = "${backupId}";
      const prior = "backup-2026-11-19-180000";
      const backup = { id: backupId, timestamp: '2026-11-20T18:00:00Z', type: 'manual', status: 'Success', totalPolicies: 1, omittedPolicies: 1, size: 1024, duration: 1, counts: { DeviceConfigurations: 1 }, scope: null, comparedWith: prior, changes: { added: 0, modified: 0, removed: 0 } };
      const path = backupId + "/DeviceConfigurations/Baseline.json";
      const blocker = "${blocker}";
      const json = payload => Promise.resolve(Response.json(payload));
      window.fetch = (input, init) => {
        switch (String(input)) {
          case '/api/list-backups': return json({ backups: [backup, { ...backup, id: prior, omittedPolicies: undefined, changes: null, comparedWith: null, timestamp: '2026-11-19T18:00:00Z' }] });
          case '/api/backup-changes': return json({ changes: [], comparedWith: prior, partial: true });
          case '/api/list-backup-contents': return json({ content: { groups: [{ area: "Device configuration", label: "Device configurations", folder: "DeviceConfigurations", policies: [{ path, displayName: "Baseline" }] }] } });
          case '/api/restore-preview': return json({ items: [{ path, folder: "DeviceConfigurations", name: "Baseline", blocker, replaceBlocker: blocker, omitted: [{ path: "/omaSettings/0/value", reason: "encrypted-oma" }] }] });
          default: return original(input, init);
        }
      };
      location.hash = "#/portal/backup";
    })()`)
    const clicked = (text) => evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    assert(await waitForText("1 with values left out"), "Backup History did not show the omission")
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('1 with values left out'))?.click()`)
    await clicked("View Changes")
    assert(await waitForText("Some values could not be compared"), "the comparison did not show partial coverage")
    assert(await waitForText("No changes found in comparable values"), "the comparison reported a mode change as a policy change")
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === "Close" || button.getAttribute("aria-label") === "Close")?.click()`)
    await clicked("Restore from this backup")
    const group = `[...document.querySelectorAll('button[aria-expanded]')].find(button => button.textContent.includes('Device configurations'))`
    assert(await waitForCondition(`Boolean(${group})`), "the policy group did not appear in restore preview")
    await evaluate(`${group}.click()`)
    assert(await waitForText(blocker), "restore preview did not explain the block")
    assert(await waitForCondition(`[...document.querySelectorAll('label')].some(label => label.textContent.includes('Baseline') && label.querySelector('[role=checkbox]:disabled'))`), "the omitted policy was selectable")
  })
}
