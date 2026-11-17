/** Keep the filter lock and restore result readable at the minimum window width. */
export async function checkRestoreService({ check, evaluate, waitForCondition, screenshot, assert, send, go }) {
  await check("restore service lock stays readable in light and dark at 1024 pixels", async () => {
    await evaluate(`(() => {
      window.__serviceRestoreFetch = window.fetch;
      window.fetch = (input, init) => {
        const route = String(input);
        const path = 'DeviceConfigurations/sidebar-restore.json';
        if (route === '/api/list-backups') return Promise.resolve(Response.json({ backups: [{ id: 'sidebar-restore', timestamp: '2026-11-16T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { DeviceConfigurations: 1 }, scope: null, size: 100, duration: 1 }] }));
        if (route === '/api/list-backup-contents') return Promise.resolve(Response.json({ content: { groups: [{ folder: 'DeviceConfigurations', label: 'configuration profile', area: 'Devices', policies: [{ path, displayName: 'Restore filter check' }] }] } }));
        if (route === '/api/restore-preview') return Promise.resolve(Response.json({ items: [{ path, name: 'Restore filter check' }] }));
        if (route === '/api/restore-backup/progress') return Promise.resolve(Response.json({ total: 1, done: 0, current: path, results: [] }));
        if (route === '/api/restore-backup') {
          if (JSON.parse(init.body).approvalAction) return Promise.resolve(Response.json({ enabled: false }));
          return new Promise(resolve => { window.__finishServiceRestore = () => resolve(Response.json({ success: true, details: { results: [{ path, success: true, action: 'created' }] } })); });
        }
        return window.__serviceRestoreFetch(input, init);
      };
    })()`)
    const click = async text => {
      const clicked = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`)
      assert(clicked, `${text} was unavailable`)
    }
    try {
      await go("#/portal/tenants", "Tenant Management")
      await go("#/portal/backup?service=intune", "Backup & Restore")
      assert(await waitForCondition(`document.querySelector('main')?.innerText.includes('Backup Timeline')`), "backup history did not load")
      await click("Refresh")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "restore fixture did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`document.querySelector('button[aria-expanded]')`), "restore items did not load")
      await evaluate(`document.querySelector('button[aria-expanded]').click()`)
      await evaluate(`document.querySelector('ul [role="checkbox"]').click()`)
      await click("Next")
      await click("Review")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText.trim().startsWith('Restore 1 item') && !b.disabled)`), "review did not finish")
      await click("Restore 1 item")
      assert(await waitForCondition(`document.querySelector('#backup-service')?.disabled && typeof window.__finishServiceRestore === 'function'`), "service filter did not lock")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('#backup-service').scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), "restore filter overflows at 1024 pixels")
        assert(await evaluate(`document.querySelector('#backup-service-locked')?.getBoundingClientRect().width > 0`), "filter lock reason is hidden")
        await screenshot(`sidebar-restore-running-${dark ? 'dark' : 'light'}-1024`)
      }
      await evaluate(`window.__finishServiceRestore()`)
      assert(await waitForCondition(`!document.querySelector('#backup-service').disabled && document.querySelector('main').innerText.includes('1 item completed.')`), "restore result did not survive")
    } finally {
      await evaluate(`window.__finishServiceRestore?.(); window.fetch = window.__serviceRestoreFetch; delete window.__serviceRestoreFetch; delete window.__finishServiceRestore; document.documentElement.classList.remove('dark')`)
      await send("Emulation.clearDeviceMetricsOverride")
      await go("#/portal/backup?tab=schedule", "Automatic backups")
    }
  })
}
