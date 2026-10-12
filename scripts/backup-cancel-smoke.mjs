/** Exercises the built progress UI with fixture fetch responses and the real cancellation IPC. */
export async function checkBackupCancel({ check, evaluate, waitForCondition, screenshot, assert, go }) {
  await check("manual backup cancellation is available and reports errors inline", async () => {
    let missing = ""
    await evaluate(`window.tenuvault.backups.cancel("desktop-smoke-missing")`).catch(error => { missing = error.message })
    assert(missing.includes("This backup job is no longer available"), "cancel IPC did not reach the main process")
    await evaluate(`(() => {
      window.__backupCancel = { job: { jobId: 'desktop-smoke', status: 'Running', progress: 25, progressMessage: 'Reading configuration', startTime: new Date().toISOString(), isComplete: false, isSuccessful: false } };
      window.__backupCancelFetch = window.fetch;
      window.fetch = (input, init) => {
        const path = String(input);
        if (path === '/api/backup/start') return Promise.resolve(Response.json({ jobId: 'desktop-smoke' }));
        if (path === '/api/backup/status') return Promise.resolve(Response.json(window.__backupCancel.job));
        if (path === '/api/list-backups') return Promise.resolve(Response.json({ backups: [] }));
        return window.__backupCancelFetch(input, init);
      };
    })()`)
    const button = label => `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
    try {
      await go("#/portal/backup", "Run Backup")
      await evaluate(`${button("Run Backup")}.click()`)
      assert(await waitForCondition(`${button("Start backup")}?.disabled === false`), "backup choice did not load")
      await evaluate(`${button("Start backup")}.click()`)
      assert(await waitForCondition(`Boolean(${button("Cancel backup")})`), "running backup has no cancel button")
      await screenshot("backup-cancel-control")
      await evaluate(`${button("Cancel backup")}.click()`)
      assert(await waitForCondition(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('This backup job is no longer available')`), "cancellation error was not shown inline")
      await evaluate(`Object.assign(window.__backupCancel.job, { status: 'Failed', progress: 100, progressMessage: 'Backup failed', exception: 'Backup cancelled by you. Earlier policies in this run were saved; the backup is incomplete.', endTime: new Date().toISOString(), isComplete: true })`)
      assert(await waitForCondition(`document.body.textContent.includes('Backup cancelled by you') && Boolean(${button("Close")})`), "cancelled job did not keep its reason open")
      await screenshot("backup-cancelled")
      await evaluate(`${button("Close")}.click()`)
    } finally {
      await evaluate("window.fetch = window.__backupCancelFetch; delete window.__backupCancelFetch; delete window.__backupCancel")
      // Leave no fixture dialog mounted when a check fails.
      await evaluate(`document.querySelector('[role="dialog"] button[data-dialog-close]')?.click()`)
    }
  })
}
