// Built-renderer interaction proof. Capture/catalog data are synthetic; no helper or Graph call.
export async function checkAppBackupCompletion({ check, evaluate, waitForCondition, screenshot, assert, send }) {
  await check("App Backup completion opens its exact backup and requests its local folder", async () => {
    const doc = "window.__appCompletionFrame.contentDocument"
    const control = label => `[...${doc}.querySelectorAll('button,a')].find(element => element.textContent.trim() === ${JSON.stringify(label)})`
    try {
      await evaluate(`(() => {
        const tenant = '11111111-1111-1111-1111-111111111111';
        const source = { id: '55555555-5555-5555-5555-555555555555', tenantId: tenant, appName: 'PowerShell', fileName: 'PowerShell-capture.zip', bytes: 123779448, sha256: 'a'.repeat(64), keyId: 'b'.repeat(32), createdAt: '2026-11-14T13:27:27Z', provenance: 'intune-capture', format: 'win32-source-zip', receipt: { schema: 1, tenantId: tenant, appId: tenant, appType: '#microsoft.graph.win32LobApp', contentVersion: '1', contentFileId: 'sha256:' + 'c'.repeat(64), encryptedSha256: 'd'.repeat(64), encryptedBytes: 123779504 } };
        const fixture = window.__appCompletion = { source, completed: false, opened: [] };
        const older = { ...source, id: '66666666-6666-6666-6666-666666666666', fileName: 'PowerShell-older-capture.zip' };
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999';
        document.body.appendChild(frame); window.__appCompletionFrame = frame;
        frame.contentWindow.history.replaceState(null, '', window.location.href);
        frame.contentWindow.location.hash = '#/portal/app-backup';
        frame.contentWindow.tenuvault = {
          ...window.tenuvault,
          app: { ...window.tenuvault.app, info: async () => ({ ...await window.tenuvault.app.info(), platform: 'win32' }) },
          auth: { ...window.tenuvault.auth, accounts: async () => [{ tenantId: tenant }, { tenantId: '33333333-3333-3333-3333-333333333333' }] },
          appSources: {
            ...window.tenuvault.appSources,
            apps: async () => ({ apps: [{ id: tenant, name: 'PowerShell', publisher: 'Microsoft', version: '7.5', installContext: 'system' }], fetchedAt: new Date().toISOString() }),
            list: async () => ({ storeName: 'TenuVault App Sources', sources: fixture.completed ? [older, source] : [older], warnings: [] }),
            assignments: async () => ({ appId: tenant, checkedAt: new Date().toISOString(), status: 'device-targeted', summary: 'A device assignment includes this PC.', steps: [], warnings: [], assignments: [] }),
            capture: async () => { fixture.completed = true; return source },
            captureProgress: async () => null,
            restoreReview: async () => ({ settingsHash: 'a'.repeat(64), observedAt: '2026-11-14T13:27:27Z', currentSettings: false, name: 'PowerShell', version: '7.6.0', publisher: 'Microsoft', installCommand: 'setup.exe /quiet', uninstallCommand: 'setup.exe /uninstall', runAs: 'system', detectionRules: 1, requirementRules: 0, blocker: null }),
            restoreProgress: async () => null,
            restore: async (sourceTenant, operation, sourceId, targetTenant, name, settingsHash) => {
              fixture.restored = { sourceTenant, sourceId, targetTenant, name, settingsHash };
              return { sourceId, tenantId: targetTenant, name, appId: '77777777-7777-7777-7777-777777777777', contentVersion: '1' };
            },
            openFolder: async (tenantId, sourceId) => { fixture.opened.push({ tenantId, sourceId }) },
          },
        };
        frame.contentDocument.body.innerHTML = '<div id="root"></div>';
        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()));
        const style = frame.contentDocument.createElement('style');
        style.textContent = '*,*::before,*::after { animation:none!important;transition:none!important }';
        frame.contentDocument.head.appendChild(style);
        const script = frame.contentDocument.createElement('script'); script.type = 'module';
        script.src = document.querySelector('script[type="module"]').src; frame.contentDocument.head.appendChild(script);
      })()`)
      assert(await waitForCondition(`Boolean(${control("Backup for PowerShell")})`), "fixture inventory did not load")
      await evaluate(`${control("Backup for PowerShell")}.click()`)
      assert(await waitForCondition(`Boolean(${control("Start backup")} && !${control("Start backup")}.disabled)`), "assignment check did not finish")
      await evaluate(`${control("Start backup")}.click()`)
      assert(await waitForCondition(`Boolean(${control("View this backup")})`), "completion action missing")
      await evaluate(`${control("View this backup")}.closest('[role="status"]').scrollIntoView({block:'center'})`)
      await screenshot("09c-app-backup-complete")
      await evaluate(`${control("Open local folder")}.click()`)
      assert(await waitForCondition(`window.__appCompletion.opened.length === 1`), "folder action missing")
      assert(await evaluate(`window.__appCompletion.opened[0].sourceId === window.__appCompletion.source.id && window.__appCompletion.opened[0].tenantId === window.__appCompletion.source.tenantId`), "folder action targeted a different backup")
      await evaluate(`${control("View this backup")}.click()`)
      const catalog = `${doc}.querySelector('[aria-labelledby="stored-sources-heading"]')`
      assert(await waitForCondition(`Boolean(${catalog}?.innerText.includes('PowerShell-capture.zip'))`), "new backup not selected")
      assert(!(await evaluate(`${catalog}.innerText.includes('PowerShell-older-capture.zip')`)), "another version leaked into the selected backup")
      assert(await waitForCondition(`${doc}.activeElement === ${catalog}.querySelector('h3')`), "selected backup did not receive keyboard focus")
      await screenshot("09d-app-backup-selected")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false })
      assert(await waitForCondition(`${doc}.documentElement.scrollWidth <= window.__appCompletionFrame.contentWindow.innerWidth + 1`), "selected backup overflows at minimum width")
      await screenshot("09e-app-backup-selected-narrow")
      await evaluate(`${control("View all backups")}.click()`)
      assert(await waitForCondition(`${catalog}.innerText.includes('PowerShell-older-capture.zip')`), "view all did not restore other backups")
      await send("Emulation.clearDeviceMetricsOverride")
      await evaluate(`${control("Restore to tenant…")}.click()`)
      assert(await waitForCondition(`Boolean(${doc}.getElementById('restore-target'))`), "restore review did not load")
      assert(await evaluate(`${control("Restore unassigned app")}.disabled`), "restore must require destination confirmation")
      await evaluate(`(() => { const select = ${doc}.getElementById('restore-target'); select.value = '33333333-3333-3333-3333-333333333333'; select.dispatchEvent(new window.__appCompletionFrame.contentWindow.Event('change', {bubbles:true})); })()`)
      await screenshot("09f-app-restore-review")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false })
      await evaluate(`${doc}.documentElement.classList.add('dark')`)
      assert(await waitForCondition(`${doc}.documentElement.scrollWidth <= window.__appCompletionFrame.contentWindow.innerWidth + 1`), "restore dialog overflows at minimum width")
      await screenshot("09g-app-restore-review-dark-narrow")
      await evaluate(`${doc}.querySelector('[role=dialog] input[type=checkbox]').click()`)
      assert(await waitForCondition(`!${control("Restore unassigned app")}.disabled`), "restore stayed disabled after review")
      await evaluate(`${control("Restore unassigned app")}.click()`)
      assert(await waitForCondition(`Boolean(${control("Open restored app")})`), "restore completion action missing")
      assert(await evaluate(`window.__appCompletion.restored.sourceTenant === window.__appCompletion.source.tenantId && window.__appCompletion.restored.targetTenant === '33333333-3333-3333-3333-333333333333'`), "restore used the wrong tenant")
      await screenshot("09h-app-restore-complete")
    } finally {
      await send("Emulation.clearDeviceMetricsOverride")
      await evaluate("window.__appCompletionFrame?.remove(); delete window.__appCompletionFrame; delete window.__appCompletion")
    }
  })
}
