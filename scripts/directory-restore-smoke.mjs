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
          if (body.action === 'discard') return Promise.resolve(Response.json({ discarded: true, canDiscard: false }));
          if (body.action === 'reconcile') {
            window.__directoryConfirmCount = (window.__directoryConfirmCount || 0) + 1;
            const uncertain = window.__directoryConfirmCount === 1;
            return Promise.resolve(Response.json({ status: 'partial', canDiscard: !uncertain, outcomes: [{ key: 'member', state: 'deferred', retryAt: Date.now() + 120000 }, ...(uncertain ? [{ key: 'unconfirmed', state: 'uncertain' }] : [])] }));
          }
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
      await click("Confirm this page's results")
      assert(await waitForCondition(`document.body.innerText.includes('Throttled by Microsoft Graph. Earliest retry:') && document.body.innerText.includes('The result is being confirmed.')`), "directory deferred and uncertain wording is missing")
      assert(await evaluate(`![...document.querySelectorAll('button')].some(b => b.innerText === 'Discard saved restore')`), "uncertain page offers discard")
      await click("Confirm this page's results")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText === 'Discard saved restore' && !b.disabled)`), "resolved page cannot discard")
      await click("Discard saved restore")
      assert(await waitForCondition(`document.body.innerText.includes('This page can never send again.')`), "discard confirmation is missing")
    } finally {
      await evaluate(`window.fetch = window.__directoryFetch; delete window.__directoryFetch; delete window.__directoryRequests; delete window.__directoryConfirmCount; document.documentElement.classList.remove('dark')`)
      await send("Emulation.clearDeviceMetricsOverride")
      await go("#/portal/backup?tab=schedule", "Automatic backups")
    }
  })
  for (const blocked of [false, true]) await check(`application ${blocked ? "recycle refusal" : "metadata restore"} shows individual review in both themes at 1024 pixels`, async () => {
    const resourceId = "00000000-0000-4000-8000-000000000010"
    const row = { key: blocked ? "application-recycle" : "application-metadata", review: {
      principal: null, resource: { id: resourceId, name: "Recovery app registration", type: "application" },
      privilege: blocked ? "recycle" : "update", scope: `tenant/application/${resourceId}`, approvals: ["directory-item"],
      notices: blocked ? ["The recycle bin preserves the object ID and app ID, but can recover credentials and previous access. It is offered for review only and remains blocked."] : [],
      changes: blocked ? [{ property: "restored", before: false, after: true }] : [
        { property: "displayName", before: "Renamed app registration", after: "Recovery app registration" },
        { property: "description", before: "Changed description", after: "Saved application description" },
      ],
      ...(blocked ? { blocker: "Recycle-bin recovery is blocked until credentials, inherited access and every recovered relationship can be completely verified. Recreation cannot bypass the recycle bin." } : {}),
      roleAssignable: false,
    } }
    await evaluate(`(() => {
      window.__directoryFetch = window.fetch; window.__directoryRequests = [];
      const backupId = 'application-restore', path = backupId + '/Applications/${resourceId}.json';
      window.fetch = (input, init) => {
        const route = String(input);
        if (route === '/api/list-backups') return Promise.resolve(Response.json({ backups: [{ id: backupId, timestamp: '2026-11-18T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { Applications: 1 }, scope: null, size: 100, duration: 1 }] }));
        if (route === '/api/list-backup-contents') return Promise.resolve(Response.json({ content: { groups: [{ folder: 'Applications', label: 'applications', area: 'Applications', policies: [{ path, displayName: 'Recovery app registration' }] }] } }));
        if (route === '/api/restore-preview') return Promise.resolve(Response.json({ items: [{ path, name: 'Recovery app registration', blocker: 'Use the separate directory review.', replaceBlocker: 'Use the separate directory review.' }] }));
        if (route === '/api/restore-directory') {
          const body = JSON.parse(init.body); window.__directoryRequests.push(body);
          return Promise.resolve(Response.json(body.action === 'preview' ? { runId: 'reviewed-application-page', fingerprint: 'bound-application-page', more: false, rows: [${JSON.stringify(row)}] } : { status: 'complete', failed: 0 }));
        }
        return window.__directoryFetch(input, init);
      };
    })()`)
    const click = async text => assert(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`), `${text} was unavailable`)
    try {
      await go("#/portal/tenants", "Tenant Management"); await go("#/portal/backup", "Backup & Restore")
      await click("Refresh")
      assert(await waitForCondition(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "application backup did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`!![...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Applications'))`), "application picker did not load")
      await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Applications')).click()`)
      await click("Review directory restore")
      await click("Preview directory changes")
      assert(await waitForCondition(`document.body.innerText.includes('Recovery app registration (application)')`), "application resource and type are missing")
      assert(await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).disabled`), "unapproved application page can execute")
      assert(await evaluate(`document.body.innerText.includes('breaks every client') && document.body.innerText.includes('SAML signing keys')`), "application recreation and credential risks are missing")
      assert(await evaluate(`document.body.innerText.includes('only when rebuilding a missing app or recovering missing configuration') && document.body.innerText.includes('Name and description updates do not require this')`), "application recovery advice is not limited to missing apps or configuration")
      if (blocked) {
        assert(await evaluate(`document.body.innerText.includes('Blocked: Recycle-bin recovery is blocked') && ![...document.querySelectorAll('label')].some(l => l.innerText.startsWith('Approve '))`), "blocked application row offers approval or has no refusal reason")
      } else {
        assert(await evaluate(`document.body.innerText.includes('displayName') && document.body.innerText.includes('description') && document.body.innerText.includes('Current: "Renamed app registration"') && document.body.innerText.includes('Restore: "Recovery app registration"') && document.body.innerText.includes('Current: "Changed description"') && document.body.innerText.includes('Restore: "Saved application description"')`), "reviewed application metadata differences are missing")
      }
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark}); [...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), "application review overflows at 1024 pixels")
        await screenshot(`application-${blocked ? "recycle-blocked" : "metadata"}-${dark ? 'dark' : 'light'}-1024`)
      }
      if (blocked) {
        await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).click()`)
        assert(await evaluate(`window.__directoryRequests.length === 1 && window.__directoryRequests[0].action === 'preview'`), "blocked application review sent an execution request")
      } else {
        await evaluate(`[...document.querySelectorAll('label')].find(l => l.innerText.startsWith('Approve this individual change')).querySelector('input').click()`)
        await click("Execute approved changes")
        assert(await waitForCondition(`document.body.innerText.includes('Directory page completed')`), "application result did not appear")
        assert(await evaluate(`window.__directoryRequests.length === 2 && window.__directoryRequests[1].action === 'restore' && window.__directoryRequests[1].runId === 'reviewed-application-page' && window.__directoryRequests[1].fingerprint === 'bound-application-page' && JSON.stringify(window.__directoryRequests[1].approvals) === JSON.stringify({ 'application-metadata': ['directory-item'] })`), "application execution was not bound to the reviewed run, fingerprint and individual approval")
      }
    } finally {
      await evaluate(`window.fetch = window.__directoryFetch; delete window.__directoryFetch; delete window.__directoryRequests; document.documentElement.classList.remove('dark')`)
      await send("Emulation.clearDeviceMetricsOverride")
      await go("#/portal/backup?tab=schedule", "Automatic backups")
    }
  })
}
