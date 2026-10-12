import { readFileSync } from "node:fs"
import { join } from "node:path"

// The development debugger creates a job in the real engine without adding a fixture API
// to the app. Its first token never resolves, so no tenant or storage request can be sent.
async function startFixture({ inspectorPort, desktopDir, evaluate, assert }) {
  const targets = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json()
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("main debugger did not connect")) }, 10000)
    socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("main debugger connection failed")) }, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  let onPaused
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data)
    if (message.method === "Debugger.paused") onPaused?.(message.params)
    if (message.id) pending.get(message.id)?.(message)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 10000)
    pending.set(id, message => {
      clearTimeout(timer)
      pending.delete(id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  let breakpointId
  let invocation
  try {
    await send("Debugger.enable")
    const source = readFileSync(join(desktopDir, "out/main/index.js"), "utf8")
    const lineNumber = source.split("\n").findIndex(line => line.includes("const job = engine.cancel(jobId)"))
    assert(lineNumber >= 0, "built cancellation handler was not found")
    ;({ breakpointId } = await send("Debugger.setBreakpointByUrl", { urlRegex: "/out/main/index\\.js$", lineNumber }))
    const paused = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cancel handler did not pause")), 10000)
      onPaused = value => { clearTimeout(timer); resolve(value) }
    })
    invocation = evaluate(`window.tenuvault.backups.cancel("desktop-smoke-missing")`).then(
      () => "", error => error.message,
    )
    const { callFrames } = await paused
    const result = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: callFrames[0].callFrameId,
      returnByValue: true,
      expression: `(() => {
        const getToken = engine.deps.getToken;
        engine.deps.getToken = () => new Promise(() => {});
        try {
          return engine.start({ tenantId: '99999999-9999-9999-9999-999999999999', clientId: 'smoke', storageAccountName: 'smokefixture', scope: { excluded: [] } }).id;
        } finally { engine.deps.getToken = getToken; }
      })()`,
    })
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? "fixture job could not start")
    await send("Debugger.removeBreakpoint", { breakpointId })
    breakpointId = undefined
    await send("Debugger.resume")
    assert((await invocation).includes("This backup job is no longer available"), "missing-job IPC did not reach the main process")
    return result.result.value
  } finally {
    if (breakpointId) await send("Debugger.removeBreakpoint", { breakpointId }).catch(() => {})
    await send("Debugger.resume").catch(() => {})
    socket.close()
    await invocation
  }
}

/** Built progress views cancel real fixture jobs and wait for the real terminal status. */
export async function checkBackupCancel({ check, evaluate, waitForCondition, screenshot, assert, inspectorPort, desktopDir }) {
  if (!inspectorPort) {
    // Packaged security fuses disable the Node debugger used to create the fixture.
    await check("packaged cancellation reaches the real IPC handler", async () => {
      const error = await evaluate(`window.tenuvault.backups.cancel("desktop-smoke-missing")`).then(() => "", error => error.message)
      assert(error.includes("This backup job is no longer available"), "missing-job cancellation did not reach main")
    })
    return
  }

  for (const view of ["dialog", "floating", "onboarding"]) {
    await check(`${view} cancellation stays disabled until terminal status arrives`, async () => {
      const jobId = await startFixture({ inspectorPort, desktopDir, evaluate, assert })
      const doc = "window.__backupCancelFrame.contentDocument"
      const button = label => `[...${doc}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
      try {
        await evaluate(`(async () => {
          const statusRequest = { path: '/api/backup/status', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ jobId: ${JSON.stringify(jobId)} })) };
          const running = await window.tenuvault.api(statusRequest);
          const fixture = window.__backupCancel = { running, statusRequest, cancelResolved: false, heldPolls: 0, releaseStatus: false, terminal: null, missingOnce: ${view === "dialog"} };
          const frame = document.createElement('iframe');
          frame.style.cssText = 'position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;';
          document.body.appendChild(frame);
          window.__backupCancelFrame = frame;
          frame.contentDocument.open();
          frame.contentDocument.write('<html><head></head><body><div id="root"></div></body></html>');
          frame.contentDocument.close();
          frame.contentWindow.location.hash = ${JSON.stringify(view === "onboarding" ? "#/portal/onboarding" : "#/portal/backup")};
          const json = data => ({ status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(data)) });
          frame.contentWindow.tenuvault = {
            ...window.tenuvault,
            storage: { ...window.tenuvault.storage, setItem: async () => {}, removeItem: async () => {} },
            auth: { ...window.tenuvault.auth, signIn: async () => ({ tenantId: '99999999-9999-9999-9999-999999999999', clientId: '22222222-2222-2222-2222-222222222222', username: 'smoke@example.test', name: 'Smoke' }) },
            license: { ...window.tenuvault.license, checkNewTenant: async () => window.tenuvault.license.status() },
            backups: { ...window.tenuvault.backups, cancel: async id => {
              const target = fixture.missingOnce ? 'desktop-smoke-missing' : id;
              fixture.missingOnce = false;
              try { await window.tenuvault.backups.cancel(target); }
              catch (error) {
                // Keep errors in the renderer's realm, as the real preload bridge does.
                throw new frame.contentWindow.Error(error.message);
              }
              fixture.cancelResolved = true;
            } },
            api: async request => {
              if (request.path === '/api/backup/start') return json({ jobId: ${JSON.stringify(jobId)} });
              if (request.path === '/api/backup/status') {
                const real = await window.tenuvault.api(statusRequest);
                const status = JSON.parse(new TextDecoder().decode(real.body));
                if (status.isComplete) fixture.terminal = status;
                if (fixture.cancelResolved && !fixture.releaseStatus) fixture.heldPolls++;
                return fixture.releaseStatus ? real : running;
              }
              if (request.path === '/api/list-backups') return json({ backups: [] });
              if (request.path === '/api/fetch-tenant-details') return json({ organization: { displayName: 'Smoke' } });
              return window.tenuvault.api(request);
            },
          };
          document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()));
          const script = frame.contentDocument.createElement('script');
          script.type = 'module';
          script.src = document.querySelector('script[type="module"]').src;
          frame.contentDocument.head.appendChild(script);
        })()`)

        if (view === "onboarding") {
          assert(await waitForCondition(`Boolean(${button("I have the client id")})`), "onboarding did not load")
          await evaluate(`${button("I have the client id")}.click()`)
          assert(await waitForCondition(`Boolean(${doc}.getElementById('tenant'))`), "sign-in form did not load")
          await evaluate(`(() => {
            const win = window.__backupCancelFrame.contentWindow;
            const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
            for (const [id, value] of [['tenant', '99999999-9999-9999-9999-999999999999'], ['clientId', '22222222-2222-2222-2222-222222222222']]) {
              const input = ${doc}.getElementById(id);
              setter.call(input, value);
              input.dispatchEvent(new win.Event('input', { bubbles: true }));
            }
          })()`)
          assert(await waitForCondition(`${button("Sign in with Microsoft")}?.disabled === false`), "fixture sign-in was not ready")
          await evaluate(`${button("Sign in with Microsoft")}.click()`)
          assert(await waitForCondition(`${button("Continue")}?.disabled === false`), "local storage choice did not load")
          await evaluate(`${button("Continue")}.click()`)
          assert(await waitForCondition(`Boolean(${button("Run first backup")})`), "first backup did not load")
          await evaluate(`${button("Run first backup")}.click()`)
        } else {
          assert(await waitForCondition(`Boolean(${button("Run Backup")})`), "backup page did not load")
          await evaluate(`${button("Run Backup")}.click()`)
          assert(await waitForCondition(`${button("Start backup")}?.disabled === false`), "backup choice did not load")
          await evaluate(`${button("Start backup")}.click()`)
          assert(await waitForCondition(`Boolean(${button("Cancel backup")})`), "running backup has no cancel button")
          if (view === "floating") await evaluate(`${button("Run in Background")}.click()`)
        }

        assert(await waitForCondition(`${button("Cancel backup")}?.disabled === false`), "cancel control did not enable for the running job")
        if (view === "dialog") {
          await evaluate(`${button("Cancel backup")}.click()`)
          assert(await waitForCondition(`${doc}.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('This backup job is no longer available') && ${button("Cancel backup")}?.disabled === false`), "cancellation failure did not show inline and allow retry")
        }
        await screenshot(`backup-cancel-${view}`)
        await evaluate(`${button("Cancel backup")}.click()`)
        assert(await waitForCondition(`window.__backupCancel.cancelResolved && window.__backupCancel.heldPolls >= 2`), "real cancellation did not finish while terminal polls were held")
        assert(await evaluate(`${button("Cancelling…")}?.disabled === true && !${button("Cancel backup")}`), "cancel control re-enabled before the terminal status arrived")
        assert(await evaluate(`window.__backupCancel.terminal?.status === 'Cancelled' && window.__backupCancel.terminal.exception.includes('Backup cancelled by you')`), "fixture did not reach the real cancelled state")
        await evaluate(`window.__backupCancel.releaseStatus = true`)
        assert(await waitForCondition(`${doc}.body.textContent.includes('Backup cancelled by you') && !${button("Cancel backup")} && !${button("Cancelling…")}`), "terminal cancellation status did not replace the control")
        await screenshot(`backup-cancelled-${view}`)
      } finally {
        await evaluate(`(() => {
          const frame = window.__backupCancelFrame;
          // Let an open progress dialog release its focus scope before discarding the frame.
          [...(frame?.contentDocument.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Close')?.click();
        })()`)
        await evaluate(`new Promise(resolve => setTimeout(resolve, 0))`)
        await evaluate(`window.__backupCancelFrame?.remove(); delete window.__backupCancelFrame; delete window.__backupCancel; window.focus(); document.querySelector('main button')?.focus()`)
        await evaluate(`window.tenuvault.backups.cancel(${JSON.stringify(jobId)})`).catch(() => {})
      }
    })
  }
}
