/** Verify the per-policy confirmation stays outside bulk selection at the minimum window width. */
export async function checkConfigurationRestore({ check, evaluate, waitForCondition, screenshot, assert, send, go }) {
  await check("configuration restore has its own difference and confirmation in light and dark at 1024 pixels", async () => {
    await evaluate(`(() => {
      window.__configurationFetch = window.fetch;
      window.__configurationRequests = [];
      const backupId = 'configuration-restore';
      const path = backupId + '/AuthenticationFlowsPolicy/Flows.json';
      window.fetch = (input, init) => {
        const route = String(input);
        if (route === '/api/list-backups') return Promise.resolve(Response.json({ backups: [{ id: backupId, timestamp: '2026-11-18T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { AuthenticationFlowsPolicy: 1 }, scope: null, size: 100, duration: 1 }] }));
        if (route === '/api/list-backup-contents') return Promise.resolve(Response.json({ content: { groups: [{ folder: 'AuthenticationFlowsPolicy', label: 'authentication flows', area: 'Authentication', policies: [{ path, displayName: 'Sign-up policy' }] }] } }));
        if (route === '/api/restore-preview') return Promise.resolve(Response.json({ items: [{ path, name: 'Sign-up policy', blocker: 'Use the separate configuration review.', replaceBlocker: 'Use the separate configuration review.' }] }));
        if (route === '/api/restore-configuration') {
          const body = JSON.parse(init.body); window.__configurationRequests.push(body);
          return Promise.resolve(Response.json(body.action === 'preview' ? { runId: 'reviewed-run', fingerprint: 'reviewed-difference', kind: 'authentication', changes: [{ property: 'selfServiceSignUp', before: { isEnabled: true }, after: { isEnabled: false } }] } : { success: true }));
        }
        return window.__configurationFetch(input, init);
      };
    })()`)
    const click = async text => {
      assert(await waitForCondition(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`), `${text} was unavailable`)
    }
    try {
      await go("#/portal/tenants", "Tenant Management")
      await go("#/portal/backup?tab=backup", "Backup Timeline")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Refresh' && !b.disabled)`), "backup history refresh did not become available")
      await click("Refresh")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "configuration backup did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`!![...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.includes('Authentication flows'))`), "configuration picker did not load")
      await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.includes('Authentication flows')).click()`)
      await click("Review this configuration")
      await click("Preview exact changes")
      assert(await waitForCondition(`document.body.innerText.includes('Confirmation: authentication')`), "own confirmation did not appear")
      assert(await evaluate(`document.body.innerText.includes('Current: {"isEnabled":true}') && document.body.innerText.includes('Restore: {"isEnabled":false}')`), "exact before and after are missing")
      assert(await evaluate(`window.__configurationRequests.length === 1 && window.__configurationRequests[0].action === 'preview'`), "preview sent a write")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark}); [...document.querySelectorAll('button')].find(b => b.innerText.includes('Confirm and restore this policy')).scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), "configuration review overflows at 1024 pixels")
        await screenshot(`configuration-restore-${dark ? 'dark' : 'light'}-1024`)
      }
      await click("Confirm and restore this policy")
      assert(await waitForCondition(`document.body.innerText.includes('Restore completed.')`), "configuration result did not appear")
      assert(await evaluate(`window.__configurationRequests[1].runId === 'reviewed-run' && window.__configurationRequests[1].fingerprint === 'reviewed-difference'`), "write was not bound to its own preview")
    } finally {
      await evaluate(`window.fetch = window.__configurationFetch; delete window.__configurationFetch; delete window.__configurationRequests; document.documentElement.classList.remove('dark')`)
      await send("Emulation.clearDeviceMetricsOverride")
      await go("#/portal/backup?tab=schedule", "Automatic backups")
    }
  })
}
