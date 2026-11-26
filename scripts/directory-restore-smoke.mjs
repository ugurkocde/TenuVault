/** Directory review stays separate from bulk selection at the minimum window width. */
export async function checkDirectoryRestore({ check, evaluate, waitForCondition, screenshot, assert, send }) {
  const frame = "window.__directorySmokeFrame"
  const doc = `${frame}.contentDocument`
  const win = `${frame}.contentWindow`
  const mountProFrame = async (apiHandlerSource) => {
    await evaluate(`(async () => {
      const status = await window.tenuvault.license.status();
      const tenants = JSON.parse(window.tenuvault.storage.getItemSync("tenuvault_tenants") || "[]");
      const tenant = tenants[0]?.credentials?.tenantId || "11111111-2222-3333-4444-555555555555";
      const fixture = {
        tenantId: tenant, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro",
        tenants: 1, expiresAt: null, validUntil: null, shared: false, displayKey: null, message: null,
      };
      const reply = (data) => ({
        status: 200, statusText: "OK", headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify(data)),
      });
      const decodeBody = (body) => body ? JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) : {};
      const handleApi = ${apiHandlerSource};
      const el = document.createElement("iframe");
      el.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;";
      document.body.appendChild(el);
      window.__directorySmokeFrame = el;
      window.__directoryRequests = [];
      const childDoc = el.contentDocument, childWin = el.contentWindow;
      childDoc.open();
      childDoc.write('<html><head></head><body><div id="root"></div></body></html>');
      childDoc.close();
      childWin.location.hash = "#/portal/backup?tab=backup";
      childWin.tenuvault = {
        ...window.tenuvault,
        license: {
          ...window.tenuvault.license,
          status: async () => ({ ...status, hasKey: true, keyState: "active", plan: "pro", tenantLimit: 1, tenants: [fixture] }),
          onChanged: () => () => {},
        },
        storage: {
          ...window.tenuvault.storage,
          getItemSync: (key) => key === "tenuvault_selected_tenant" ? (tenants[0]?.id ?? "1") : window.tenuvault.storage.getItemSync(key),
          setItem: async () => {},
        },
        api: async (request) => {
          const mocked = handleApi(request.path, decodeBody(request.body), reply);
          if (mocked) return mocked;
          return window.tenuvault.api(request);
        },
      };
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => childDoc.head.appendChild(link.cloneNode()));
      const script = childDoc.createElement("script");
      script.type = "module";
      script.src = document.querySelector('script[type="module"]').src;
      childDoc.head.appendChild(script);
    })()`)
  }
  const click = async text => assert(await waitForCondition(`(() => { const button = [...${doc}.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`), `${text} was unavailable`)
  const cleanup = async () => {
    await evaluate(`${frame}?.remove(); delete window.__directorySmokeFrame; delete window.__directoryRequests; delete window.__directoryConfirmCount`)
    await send("Emulation.clearDeviceMetricsOverride")
  }

  await check("directory restore shows individual approvals and exact group choices in both themes at 1024 pixels", async () => {
    const backupId = "directory-restore", path = `${backupId}/Groups/00000000-0000-4000-8000-000000000010.json`
    try {
      await mountProFrame(`(route, body, reply) => {
        if (route === '/api/list-backups') return reply({ backups: [{ id: ${JSON.stringify(backupId)}, timestamp: '2026-11-18T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { Groups: 1 }, scope: null, size: 100, duration: 1 }] });
        if (route === '/api/list-backup-contents') return reply({ content: { groups: [{ folder: 'Groups', label: 'groups', area: 'Groups', policies: [{ path: ${JSON.stringify(path)}, displayName: 'Recovery security group' }] }] } });
        if (route === '/api/restore-preview') return reply({ items: [{ path: ${JSON.stringify(path)}, name: 'Recovery security group', blocker: 'Use the separate directory review.', replaceBlocker: 'Use the separate directory review.' }] });
        if (route === '/api/restore-directory') {
          window.__directoryRequests.push(body);
          if (body.action === 'discard') return reply({ discarded: true, canDiscard: false });
          if (body.action === 'reconcile') {
            window.__directoryConfirmCount = (window.__directoryConfirmCount || 0) + 1;
            const uncertain = window.__directoryConfirmCount === 1;
            return reply({ status: 'partial', canDiscard: !uncertain, outcomes: [{ key: 'member', state: 'deferred', deferralCause: 'throttle', retryAt: Date.now() + 120000 }, ...(uncertain ? [{ key: 'unconfirmed', state: 'uncertain', retryAt: Date.now() + 120000 }] : [])] });
          }
          return reply(body.action === 'preview' ? { runId: 'reviewed-directory-page', fingerprint: 'bound-directory-page', more: true, rows: [{ key: 'member', review: { principal: { id: 'p', name: 'Recovery member', type: 'user' }, resource: { id: 'g', name: 'Recovery security group', type: 'group' }, privilege: 'member', scope: 'tenant/group/00000000-0000-4000-8000-000000000010', approvals: ['directory-item', 'security-response'], notices: ['The current state looks deliberate. This restore may undo a security response.'], changes: [{ property: 'present', before: false, after: true }], roleAssignable: false } }] } : { status: 'complete', failed: 0 });
        }
        return null;
      }`)
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText.trim() === 'Refresh' && !b.disabled)`), "backup history refresh did not become available")
      await click("Refresh")
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "directory backup did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`!![...${doc}.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Groups'))`), "directory picker did not load")
      await evaluate(`[...${doc}.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Groups')).click()`)
      await click("Review directory restore")
      await evaluate(`(() => { const select = [...${doc}.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'relationships')); select.value = 'relationships'; select.dispatchEvent(new ${win}.Event('change', { bubbles: true })); })()`)
      assert(await waitForCondition(`${doc}.body.innerText.includes('Exact membership for this group')`), "per-group exact choice is missing")
      await click("Preview directory changes")
      assert(await waitForCondition(`${doc}.body.innerText.includes('Recovery member (user)')`), "resolved principal is missing")
      assert(await evaluate(`[...${doc}.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).disabled`), "unapproved page can execute")
      assert(await evaluate(`${doc}.body.innerText.includes('Current: Not assigned now') && ${doc}.body.innerText.includes('Restore: Assigned after restore') && ${doc}.body.innerText.includes('undo a security response')`), "difference or security-response approval is missing")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`${doc}.documentElement.classList.toggle('dark', ${dark}); [...${doc}.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`${doc}.documentElement.scrollWidth <= ${win}.innerWidth`), "directory review overflows at 1024 pixels")
        await screenshot(`directory-restore-${dark ? 'dark' : 'light'}-1024`)
      }
      await evaluate(`[...${doc}.querySelectorAll('label')].filter(l => l.innerText.startsWith('Approve ')).forEach(l => l.querySelector('input').click())`)
      await click("Execute approved changes")
      assert(await waitForCondition(`${doc}.body.innerText.includes('Directory page completed')`), "directory result did not appear")
      assert(await evaluate(`window.__directoryRequests[1].runId === 'reviewed-directory-page' && window.__directoryRequests[1].fingerprint === 'bound-directory-page' && window.__directoryRequests[1].approvals.member.length === 2`), "directory execution was not bound to individual approvals")
      await click("Confirm this page's results")
      assert(await waitForCondition(`${doc}.body.innerText.includes('Throttled by Microsoft Graph. Earliest retry:') && ${doc}.body.innerText.includes('The result is being confirmed. Earliest retry:')`), "directory deferred and uncertain wording is missing")
      assert(await evaluate(`![...${doc}.querySelectorAll('button')].some(b => b.innerText === 'Discard saved restore')`), "uncertain page offers discard")
      await click("Confirm this page's results")
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText === 'Discard saved restore' && !b.disabled)`), "resolved page cannot discard")
      await click("Discard saved restore")
      assert(await waitForCondition(`${doc}.body.innerText.includes('This page can never send again.')`), "discard confirmation is missing")
    } finally {
      await cleanup()
    }
  })
  if (process.env.TENUVAULT_SMOKE_PRIVILEGED_RESTORE !== "1") return

  for (const scenario of ["metadata", "recycle", "verified", "pending"]) await check(`application restore review and result for ${scenario}`, async () => {
    const blocked = scenario === "recycle", temporary = scenario === "verified" || scenario === "pending"
    const pack = { label: "Entra app metadata restore", scopes: ["Application.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All"] }
    const runId = "reviewed-application-page"
    const removal = temporary ? { runId, status: scenario, scopes: [{ consentType: "AllPrincipals", principalId: null, scope: pack.scopes[1] }] } : undefined
    const wide = async (name, anchor) => {
      await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`${doc}.documentElement.classList.toggle('dark', ${dark}); [...${doc}.querySelectorAll('p, button')].find(node => node.textContent.trim().startsWith(${JSON.stringify(anchor)}))?.scrollIntoView({ block: 'center' })`)
        await screenshot(`jit-${name}-${dark ? "dark" : "light"}-1440`)
      }
    }
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
    const backupId = "application-restore", path = `${backupId}/Applications/${resourceId}.json`
    try {
      await mountProFrame(`(route, body, reply) => {
        if (route === '/api/list-backups') return reply({ backups: [{ id: ${JSON.stringify(backupId)}, timestamp: '2026-11-18T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { Applications: 1 }, scope: null, size: 100, duration: 1 }] });
        if (route === '/api/list-backup-contents') return reply({ content: { groups: [{ folder: 'Applications', label: 'applications', area: 'Applications', policies: [{ path: ${JSON.stringify(path)}, displayName: 'Recovery app registration' }] }] } });
        if (route === '/api/restore-preview') return reply({ items: [{ path: ${JSON.stringify(path)}, name: 'Recovery app registration', blocker: 'Use the separate directory review.', replaceBlocker: 'Use the separate directory review.' }] });
        if (route === '/api/restore-directory') {
          window.__directoryRequests.push(body);
          return reply(body.action === 'preview' ? { runId: 'reviewed-application-page', fingerprint: 'bound-application-page', more: false, rows: [${JSON.stringify(row)}], temporaryAccess: ${temporary ? JSON.stringify({ pack, cleanup: { checked: true } }) : "undefined"} } : { status: 'complete', failed: 0, removal: ${JSON.stringify(removal)} });
        }
        return null;
      }`)
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText.trim() === 'Refresh' && !b.disabled)`), "backup history refresh did not become available")
      await click("Refresh")
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "application backup did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`!![...${doc}.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Applications'))`), "application picker did not load")
      await evaluate(`[...${doc}.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Applications')).click()`)
      await click("Review directory restore")
      await click("Preview directory changes")
      assert(await waitForCondition(`${doc}.body.innerText.includes('Recovery app registration (application)')`), "application resource and type are missing")
      assert(await evaluate(`[...${doc}.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).disabled`), "unapproved application page can execute")
      assert(await evaluate(`${doc}.body.innerText.includes('Only nonempty app registration name and description updates run. Everything else is blocked') && ${doc}.body.innerText.includes('SAML signing keys, provisioning secrets and all credentials')`), "application admitted updates or blocked credentials are missing")
      assert(await evaluate(`!${doc}.body.innerText.includes('Each owner, consent grant and app role assignment needs its own approval') && !${doc}.body.innerText.includes('Set up single sign-on')`), "application review contradicts its blocked operations")
      if (blocked) {
        assert(await evaluate(`${doc}.body.innerText.includes('Blocked: Recycle-bin recovery is blocked') && ![...${doc}.querySelectorAll('label')].some(l => l.innerText.startsWith('Approve '))`), "blocked application row offers approval or has no refusal reason")
      } else {
        assert(await evaluate(`${doc}.body.innerText.includes('displayName') && ${doc}.body.innerText.includes('description') && ${doc}.body.innerText.includes('Current: Renamed app registration') && ${doc}.body.innerText.includes('Restore: Recovery app registration') && ${doc}.body.innerText.includes('Current: Changed description') && ${doc}.body.innerText.includes('Restore: Saved application description')`), "reviewed application metadata differences are missing")
      }
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`${doc}.documentElement.classList.toggle('dark', ${dark}); [...${doc}.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`${doc}.documentElement.scrollWidth <= ${win}.innerWidth`), "application review overflows at 1024 pixels")
        await screenshot(`application-${blocked ? "recycle-blocked" : "metadata"}-${dark ? 'dark' : 'light'}-1024`)
      }
      if (scenario === "metadata" || scenario === "verified") await wide(scenario === "metadata" ? "before-review" : "after-review", "Execute approved changes")
      if (blocked) {
        await evaluate(`[...${doc}.querySelectorAll('button')].find(b => b.innerText.startsWith('Execute approved')).click()`)
        assert(await evaluate(`window.__directoryRequests.length === 1 && window.__directoryRequests[0].action === 'preview'`), "blocked application review sent an execution request")
      } else {
        await evaluate(`[...${doc}.querySelectorAll('label')].find(l => l.innerText.startsWith('Approve this individual change')).querySelector('input').click()`)
        if (temporary) {
          assert(await evaluate(`[...${doc}.querySelectorAll('label')].some(label => label.innerText.includes('Remove permissions added by this restore') && label.querySelector('input').checked)`), "the mandatory removal checkbox is missing")
          if (scenario === "verified") await wide("after-offer", "Temporary permission for app metadata restore")
        }
        await click("Execute approved changes")
        assert(await waitForCondition(`${doc}.body.innerText.includes('Directory page completed')`), "application result did not appear")
        if (temporary) {
          const heading = scenario === "pending" ? "Temporary permission removal pending" : "Temporary permission removal verified"
          assert(await waitForCondition(`${doc}.body.innerText.includes(${JSON.stringify(heading)})`), "permission removal result did not appear")
          await wide(`after-${scenario}`, heading)
        }
        assert(await evaluate(`window.__directoryRequests.length === 2 && window.__directoryRequests[1].action === 'restore' && window.__directoryRequests[1].runId === 'reviewed-application-page' && window.__directoryRequests[1].fingerprint === 'bound-application-page' && JSON.stringify(window.__directoryRequests[1].approvals) === JSON.stringify({ 'application-metadata': ['directory-item'] })`), "application execution was not bound to the reviewed run, fingerprint and individual approval")
      }
    } finally {
      await cleanup()
    }
  })
  await check("role and PIM review shows the original end date without an execution action in both themes at 1024 pixels", async () => {
    const backupId = "pim-restore", folder = "RoleAssignmentSchedules", path = `${backupId}/${folder}/schedule.json`, name = "Time-bound administrative role"
    try {
      await mountProFrame(`(route, body, reply) => {
        if (route === '/api/list-backups') return reply({ backups: [{ id: ${JSON.stringify(backupId)}, timestamp: '2026-11-18T00:00:00Z', status: 'Success', totalPolicies: 1, counts: { [${JSON.stringify(folder)}]: 1 }, scope: null, size: 100, duration: 1 }] });
        if (route === '/api/list-backup-contents') return reply({ content: { groups: [{ folder: ${JSON.stringify(folder)}, label: 'Role assignment schedules', area: 'Roles and PIM', policies: [{ path: ${JSON.stringify(path)}, displayName: ${JSON.stringify(name)} }] }] } });
        if (route === '/api/restore-preview') return reply({ items: [{ path: ${JSON.stringify(path)}, name: ${JSON.stringify(name)}, blocker: 'Use the separate directory review.', replaceBlocker: 'Use the separate directory review.' }] });
        if (route === '/api/restore-directory') {
          if (body.action !== 'preview') throw new Error('This staged review must only preview');
          return reply({ runId: 'saved-pim-page', fingerprint: 'pim-page', more: false, rows: [{ key: 'schedule', review: {
            principal: { id: 'user', name: 'Fixture reader', type: 'user' }, resource: { id: 'role', name: 'Reader', type: 'directory role' },
            privilege: 'Active role schedule', scope: 'Entire tenant', approvals: ['directory-item', 'privileged-relationship', 'security-response'],
            notices: ['The current state looks deliberate. Restoring removed access may undo a security response.'],
            changes: [{ property: 'Schedule', before: null, after: { end: '2026-12-01T18:00:00Z' } }, { property: 'Relationship', before: 'Absent', after: 'Present' }], blocker: 'Restoring roles and PIM is not available yet. You can review what would change.', roleAssignable: false,
          } }] });
        }
        return null;
      }`)
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText.trim() === 'Refresh' && !b.disabled)`), "backup history refresh did not become available")
      await click("Refresh")
      assert(await waitForCondition(`[...${doc}.querySelectorAll('button')].some(b => b.innerText.includes('Restore from this backup') && !b.disabled)`), "PIM backup did not load")
      await click("Restore from this backup")
      assert(await waitForCondition(`!![...${doc}.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.trim().startsWith('Role assignment schedules'))`), "PIM picker did not load")
      await click("Role assignment schedules")
      await click("Review directory restore")
      await click("Preview directory changes")
      assert(await waitForCondition(`${doc}.body.innerText.includes('Fixture reader (user)')`), "PIM principal did not resolve in the review")
      assert(await evaluate(`${doc}.body.innerText.includes('Entire tenant') && ${doc}.body.innerText.includes('Current: None') && ${doc}.body.innerText.includes('Saved in backup: Assigned until ' + new Date('2026-12-01T18:00:00Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) + ' (UTC') && ${doc}.body.innerText.includes('Blocked: Restoring roles and PIM is not available yet. You can review what would change.') && ${doc}.body.innerText.includes('undo a security response') && ![...${doc}.querySelectorAll('button')].some(b => b.innerText.startsWith('Execute approved'))`), "PIM scope, saved end date or execution blocker is missing")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`${doc}.documentElement.classList.toggle('dark', ${dark}); [...${doc}.querySelectorAll('strong')].find(b => b.innerText.includes('Fixture reader (user)')).scrollIntoView({ block: 'center' })`)
        assert(await evaluate(`${doc}.documentElement.scrollWidth <= ${win}.innerWidth`), "PIM review overflows at 1024 pixels")
        await screenshot(`pim-restore-${dark ? 'dark' : 'light'}-1024`)
      }
    } finally {
      await cleanup()
    }
  })
}
