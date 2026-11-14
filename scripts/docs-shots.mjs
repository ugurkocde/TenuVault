/**
 * Documentation captures of the current Electron renderer, using fictional tenants.
 * npm run build && DOCS_SHOTS=1 MARKETING_SCALE=2 node scripts/marketing-shots.mjs out/docs-shots
 * Uses the marketing harness's disposable profile. API responses are local fixtures;
 * no Microsoft sign-in, tenant write, email or webhook is performed.
 */
export async function captureDocs({ main, send, evaluate, go, click, assertText, scrollAll, screenshot, sleep }) {
  // Empty initial workspaces are intentional: do not invent compliance assessments,
  // deployments or successful reviews to illustrate a feature's setup controls.
  await main.evaluate(`(() => {
    const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/docs-shots.cjs')
    const { ipcMain } = req('electron')
    const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => fn(...args)) }
    const tenantId = globalThis.__marketingMock.accounts[0].tenantId
    const app = { id:'11111111-1111-4111-8111-111111111111', name:'PowerShell', publisher:'Microsoft', version:'7.6.0', installContext:'system' }
    const source = { id:'55555555-5555-4555-8555-555555555555', tenantId, appName:'PowerShell', fileName:'PowerShell-capture.zip', bytes:123779448, sha256:'a'.repeat(64), keyId:'b'.repeat(32), createdAt:new Date().toISOString(), provenance:'intune-capture', format:'win32-source-zip', receipt:{schema:1,tenantId,appId:app.id,appType:'#microsoft.graph.win32LobApp',contentVersion:'1',contentFileId:'sha256:'+'c'.repeat(64),encryptedSha256:'d'.repeat(64),encryptedBytes:123779504} }
    handle('appSources:apps', () => ({apps:[app], fetchedAt:new Date().toISOString()}))
    handle('appSources:list', () => ({storeName:'TenuVault App Sources',sources:[source],warnings:[]}))
    handle('appSources:restoreReview', () => ({settingsHash:'a'.repeat(64),observedAt:source.createdAt,currentSettings:false,name:app.name,version:app.version,publisher:app.publisher,installCommand:'setup.exe /quiet',uninstallCommand:'setup.exe /uninstall',runAs:'system',detectionRules:1,requirementRules:0,blocker:null}))
    const previous = ipcMain._invokeHandlers.get('api')
    const json = value => ({ status: 200, statusText: 'OK', headers: {'content-type':'application/json'}, body: new TextEncoder().encode(JSON.stringify(value)) })
    ipcMain.removeHandler('api')
    ipcMain.handle('api', (event, request) => {
      const body = request.body ? JSON.parse(new TextDecoder().decode(request.body)) : {}
      const path = request.path.split('?')[0]
      if (path === '/api/restore-journal') return json({records:[]})
      if (path === '/api/sync') {
        const M = globalThis.__marketingMock
        if (body.action === 'policies') return json({source:[{id:'sample-defender', name:'WIN - Defender Antivirus - Baseline', folder:'ConfigurationPolicies', platforms:'windows10', lastModifiedDateTime:null}]})
        if (body.action === 'targets') return json({multiple:true, targets:M.accounts.filter(a => a.tenantId !== body.tenantId).map(a => ({tenantId:a.tenantId, eligible:true, multiple:true, reason:'msp'}))})
        if (body.action === 'status') return json({targets:[]})
        return json({runs:[]})
      }
      if (path === '/api/reports') return json({licensed:true, runtimeNote:'Automatic reports run while TenuVault is running and you are signed in.', reports:[], settings:{recipients:[], afterScheduledBackup:false, skipEmpty:true, includeValues:true, includeActors:true, attachment:'pdf', lastAutomatic:null}})
      if (path === '/api/scores') return json({tenantId:body.tenantId, tenantName:'Contoso Ltd', formula:'Score = matching capabilities / evaluated capabilities', staleAfterDays:7, scoringChanged:false, frameworks:[]})
      if (path === '/api/hygiene') return json({rules:[], scans:[], findings:[], total:0})
      if (path === '/api/standards') return json({customizations:[], standards:[], adoptions:[]})
      if (path === '/api/promotion') return json({promotions:[], source:[], destination:[]})
      if (path === '/api/baseline-upgrades') return json({installs:[], upgrades:[], runs:[]})
      if (path === '/api/custom-baselines') return json({baselines:[], deployments:[], comparisons:[], snapshots:[]})
      if (path === '/api/health-review') {
        if (body.action === 'list-findings') return json({findings:[]})
        if (body.action === 'list-runs') return json({runs:[]})
        return json({schedule:null, readiness:{state:'disabled', message:'Review schedule is off.', signedIn:true, licensed:true, note:'Scheduled reviews run while TenuVault is running.'}, lastRun:null, counts:{critical:0, high:0, medium:0, low:0, unknown:0}, thresholds:{}, endpoints:[]})
      }
      return previous(event, request)
    })
    globalThis.__marketingMock.noMaa = true
  })()`)
  await send('Emulation.setDeviceMetricsOverride', {width:1440, height:1000, deviceScaleFactor:Number(process.env.MARKETING_SCALE ?? 2), mobile:false})
  const capture = async (name, route, text) => {
    await go(route, text)
    await sleep(1000)
    await scrollAll(0)
    await evaluate('document.fonts.ready.then(() => true)')
    await screenshot(name)
  }
  const captureCloud = async () => {
    // Use the example Azure-backed tenant so the handoff has its storage prerequisites.
    await evaluate(`window.tenuvault.storage.setItem('tenuvault_selected_tenant', '2')`)
    await evaluate('location.reload()')
    await sleep(1500)
    await send('Emulation.setDeviceMetricsOverride', {width:1440, height:1800, deviceScaleFactor:Number(process.env.MARKETING_SCALE ?? 2), mobile:false})
    await go('#/portal/backup?tab=schedule', 'Automatic backups')
    await click('In Azure, no computer needed')
    await assertText('Deploy to Azure')
    await scrollAll(0)
    await screenshot('backup-cloud')
    await evaluate(`window.tenuvault.storage.setItem('tenuvault_selected_tenant', '1')`)
    await evaluate('location.reload()')
    await sleep(1500)
    await send('Emulation.setDeviceMetricsOverride', {width:1440, height:1000, deviceScaleFactor:Number(process.env.MARKETING_SCALE ?? 2), mobile:false})
  }
  if (process.env.DOCS_SHOTS_CLOUD_ONLY === '1') return captureCloud()
  await capture('tenants-overview', '#/portal/overview', 'All tenants')
  await capture('dashboard', '#/portal/dashboard', 'Policies protected')
  await capture('tenant-management', '#/portal/tenants', 'Contoso Ltd')
  await capture('backup-history', '#/portal/backup', 'Backup Timeline')
  await click('Run Backup')
  await assertText('Start backup')
  await screenshot('backup-scope')
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27})
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27})
  await capture('backup-schedule', '#/portal/backup?tab=schedule', 'Automatic backups')
  await capture('restore-backup', '#/portal/backup?tab=restore', 'Choose a backup')
  await evaluate(`document.querySelector('[role="option"]').click()`)
  await assertText('Select all')
  await screenshot('restore-selection')
  await click('Select all')
  await click('Next')
  await screenshot('restore-method')
  await click('Review')
  await assertText('Restore 1 item')
  await screenshot('restore-review')
  await capture('drift-results', '#/portal/drift', 'WIN - Defender Antivirus - Baseline')
  await capture('audit-log', '#/portal/audit', 'Audit Log')
  await capture('setup-connect', '#/portal/onboarding', 'Connect your tenant')
  await capture('license', '#/license', 'License')
  for (const [section, text] of [['signin','Sign-in'], ['storage','Encryption key'], ['background','Background runner'], ['appearance','Appearance'], ['branding','PDF branding']]) {
    await capture('settings-' + section, '#/portal/settings?section=' + section, text)
  }
  await capture('reports', '#/portal/reports', 'New change report')
  await capture('governance', '#/portal/governance', 'Export evidence pack')
  await capture('hygiene', '#/portal/governance/hygiene', 'Conflicts and hygiene')
  await capture('customizations', '#/portal/governance/customizations', 'Customizations')
  await capture('changes', '#/portal/changes', 'Dev to Prod')
  await capture('baseline-upgrades', '#/portal/changes/baseline-upgrades', 'Installed baselines')
  await capture('operations', '#/portal/operations', 'Review now')
  await capture('custom-baselines', '#/portal/baselines', 'My baselines')
  await capture('sync', '#/portal/sync', 'Sync')
  await captureCloud()
  await go('#/portal/onboarding', 'Connect your tenant')
  await click('I already have an app registration')
  await assertText('Sign in to your tenant')
  await screenshot('setup-signin')
  await go('#/portal/dashboard', 'Policies protected')
  await evaluate(`window.tenuvault.storage.setItem('tenuvault.onboarding.draft', JSON.stringify({step:2,tenant:'contoso.onmicrosoft.com',clientId:'5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3',displayName:'Contoso Ltd',account:{tenantId:'8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14',clientId:'5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3',username:'admin@contoso.onmicrosoft.com',name:'Megan Bowen'},signedInAt:Date.now()}))`)
  await capture('setup-storage', '#/portal/onboarding', 'Choose where backups are stored')
  await capture('app-backup-apps', '#/portal/app-backup', 'PowerShell')
  await capture('app-backup-installers', '#/portal/app-backup/versions', 'PowerShell')
  await click('Restore to tenant…')
  await assertText('Restore unassigned app')
  await screenshot('app-backup-restore')
}
