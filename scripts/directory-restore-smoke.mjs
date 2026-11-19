/** Directory review stays separate from bulk selection at the minimum window width. */
export async function checkDirectoryRestore({ check, evaluate, waitForCondition, screenshot, assert, send, go }) {
  await check("directory restore shows individual approvals and exact group choices in both themes at 1024 pixels", async () => {
    await evaluate(`(() => {
      window.__directoryFetch = window.fetch; window.__directoryRequests = [];
      const backupId = 'directory-restore', path = backupId + '/Groups/00000000-0000-4000-8000-000000000010.json';
      window.fetch = (input, init) => {
        const route = String(input);
        if (route === '/api/list-backups') return Promise.resolve(Response.json({ backups: [{ id: backupId, timestamp: '2026-11-18T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { Groups: 1 }, scope: null, size: 100, duration: 1 }] }));
        if (route === '/api/list-backup-contents') return Promise.resolve(Response.json({ content: { groups: [{ folder: 'Groups', label: 'groups', area: 'Groups', policies: [{ path, displayName: 'Recovery security group' }] }] } }));
        if (route === '/api/restore-preview') return Promise.resolve(Response.json({ items: [{ path, name: 'Recovery security group', blocker: 'Use the separate directory review.', replaceBlocker: 'Use the separate directory review.' }] }));
        if (route === '/api/restore-directory') {
          const body = JSON.parse(init.body); window.__directoryRequests.push(body);
          return Promise.resolve(Response.json(body.action === 'preview' ? { runId: 'reviewed-directory-page', fingerprint: 'bound-directory-page', more: true, rows: [{ key: 'member', review: { principal: { id: 'p', name: 'Recovery member', type: 'user' }, resource: { id: 'g', name: 'Recovery security group', type: 'group' }, privilege: 'member', scope: 'tenant/group/00000000-0000-4000-8000-000000000010', approvals: ['directory-item', 'security-response'], notices: ['The current state looks deliberate. This restore may undo a security response.'], changes: [{ property: 'present', before: false, after: true }], roleAssignable: false } }] } : { status: 'complete', failed: 0 }));
        }
        return window.__directoryFetch(input, init);
      };
    })()`)
    const click = async text => assert(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`), `${text} was unavailable`)
    try {
      await go("#/portal/tenants", "Tenant Management"); await go("#/portal/backup", "Backup & Restore")
      await click("Refresh")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "directory backup did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`!![...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Groups'))`), "directory picker did not load")
      await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Groups')).click()`)
      await click("Review directory restore")
      await evaluate(`(() => { const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'relationships')); select.value = 'relationships'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
      assert(await waitForCondition(`document.body.innerText.includes('Exact membership for this group')`), "per-group exact choice is missing")
      await click("Preview directory changes")
      assert(await waitForCondition(`document.body.innerText.includes('Recovery member (user)')`), "resolved principal is missing")
      assert(await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).disabled`), "unapproved page can execute")
      assert(await evaluate(`document.body.innerText.includes('Current: false') && document.body.innerText.includes('Restore: true') && document.body.innerText.includes('undo a security response')`), "difference or security-response approval is missing")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark}); [...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), "directory review overflows at 1024 pixels")
        await screenshot(`directory-restore-${dark ? 'dark' : 'light'}-1024`)
      }
      await evaluate(`[...document.querySelectorAll('label')].filter(l => l.innerText.startsWith('Approve ')).forEach(l => l.querySelector('input').click())`)
      await click("Execute approved changes")
      assert(await waitForCondition(`document.body.innerText.includes('Directory page completed')`), "directory result did not appear")
      assert(await evaluate(`window.__directoryRequests[1].runId === 'reviewed-directory-page' && window.__directoryRequests[1].fingerprint === 'bound-directory-page' && window.__directoryRequests[1].approvals.member.length === 2`), "directory execution was not bound to individual approvals")
    } finally {
      await evaluate(`window.fetch = window.__directoryFetch; delete window.__directoryFetch; delete window.__directoryRequests; document.documentElement.classList.remove('dark')`)
      await send("Emulation.clearDeviceMetricsOverride")
      await go("#/portal/backup?tab=schedule", "Automatic backups")
    }
  })
}
