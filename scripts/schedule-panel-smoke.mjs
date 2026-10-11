/** Exercise the built schedule editor with controlled license and runner responses. */
export async function checkSchedulePanel({ check, evaluate, waitForCondition, screenshot, assert }) {
  const tenantId = "11111111-1111-1111-1111-111111111111"
  const doc = "window.__scheduleFrame.contentDocument"
  const body = `${doc}.body`
  const save = `[...${body}.querySelectorAll("button")].find(button => button.textContent.trim() === "Save")`
  const automatic = `${body}.querySelector('input[type="checkbox"]')`

  async function open(current = null, installed = false) {
    await evaluate(`(async () => {
      const status = await window.tenuvault.license.status()
      window.__scheduleFixture = { calls: [], runnerChecks: 0, status: { ...status, tenants: [] } }
      const frame = document.createElement("iframe")
      frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 9999;"
      document.body.appendChild(frame)
      window.__scheduleFrame = frame
      frame.contentDocument.open()
      frame.contentDocument.write('<html><head></head><body><div id="root"></div></body></html>')
      frame.contentDocument.close()
      frame.contentWindow.location.hash = "#/portal/backup?tab=schedule"
      frame.contentWindow.tenuvault = {
        ...window.tenuvault,
        license: {
          ...window.tenuvault.license,
          status: () => Promise.resolve(window.__scheduleFixture.status),
          onChanged: listener => {
            window.__scheduleFixture.planChanged = listener
            return () => { window.__scheduleFixture.planChanged = null }
          },
        },
        schedules: {
          ...window.tenuvault.schedules,
          list: () => Promise.resolve(${JSON.stringify(current ? [current] : [])}),
          onChanged: listener => {
            window.__scheduleFixture.scheduleChanged = listener
            return () => { window.__scheduleFixture.scheduleChanged = null }
          },
          set: async input => {
            window.__scheduleFixture.calls.push(input)
            const schedules = await window.tenuvault.schedules.set(input)
            window.__scheduleFixture.scheduleChanged(schedules)
            return schedules
          },
        },
        backgroundLaunch: {
          ...window.tenuvault.backgroundLaunch,
          status: async () => {
            window.__scheduleFixture.runnerChecks++
            return { supported: true, installed: ${installed} }
          },
        },
      }
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => frame.contentDocument.head.appendChild(link.cloneNode()))
      const script = frame.contentDocument.createElement("script")
      script.type = "module"
      script.src = document.querySelector('script[type="module"]').src
      frame.contentDocument.head.appendChild(script)
    })()`)
    assert(await waitForCondition(`${body}.innerText.includes("Back up Contoso 1 automatically")`), "schedule fixture did not open")
  }

  async function community() {
    await evaluate(`window.__scheduleFixture.planChanged({ ...window.__scheduleFixture.status, tenants: [{ tenantId: ${JSON.stringify(tenantId)}, plan: "community", entitled: true }] })`)
    assert(await waitForCondition(`!${body}.innerText.includes("Checking plan") && !${body}.innerText.includes("Plan not verified")`), "known plan still shows an unavailable plan message")
  }

  async function setValue(id, value) {
    await evaluate(`(() => {
      const input = ${doc}.getElementById(${JSON.stringify(id)})
      const win = window.__scheduleFrame.contentWindow
      const prototype = input.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new win.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }))
    })()`)
  }

  async function close() {
    await evaluate(`window.__scheduleFrame?.remove(); delete window.__scheduleFrame; delete window.__scheduleFixture; document.querySelector('main button')?.focus()`)
    await evaluate(`window.tenuvault.schedules.remove(${JSON.stringify(tenantId)})`)
  }

  await check("schedule drafts hide Daily until the plan is known and validate time before IPC", async () => {
    try {
      await open()
      await evaluate(`${automatic}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes("Checking plan")`), "unknown plan message missing")
      assert(await evaluate(`!${doc}.querySelector('#schedule-frequency option[value="daily"]')`), "Daily offered before plan is known")
      await setValue("schedule-weekday", "2")
      for (const value of ["", "25:00"]) {
        const beforeToast = await evaluate(`${body}.querySelector('[role="status"].pointer-events-none')?.textContent ?? ''`)
        await setValue("schedule-time", value)
        await evaluate(`${save}.click()`)
        assert(await waitForCondition(`${doc}.getElementById('schedule-time-error')?.textContent === 'Choose a time, for example 07:45.'`), "inline time error missing")
        assert(await evaluate(`(() => {
          const input = ${doc}.getElementById('schedule-time')
          return input.getAttribute('aria-invalid') === 'true' && input.getAttribute('aria-describedby') === 'schedule-time-error' && ${doc}.activeElement === input
        })()`), "time error attributes or focus missing")
        assert(await evaluate(`${doc}.getElementById('schedule-frequency').value === 'weekly' && ${doc}.getElementById('schedule-weekday').value === '2'`), "validation changed recurrence or weekday")
        assert(await evaluate(`window.__scheduleFixture.calls.length === 0`), "invalid time reached IPC")
        const afterToast = await evaluate(`${body}.querySelector('[role="status"].pointer-events-none')?.textContent ?? ''`)
        assert(afterToast === beforeToast, `invalid time produced a toast: ${afterToast}`)
      }
      await screenshot("09a-schedule-time-validation")
      await evaluate(`window.__scheduleFixture.status = {
        ...window.__scheduleFixture.status, hasKey: true, plan: "msp", tenantLimit: 5,
        tenants: [{ tenantId: ${JSON.stringify(tenantId)}, entitled: false, plan: null, message: "This license already covers its maximum number of tenants." }],
      }`)
      for (let response = 0; response < 2; response++) {
        await evaluate(`window.__scheduleFixture.planChanged({ ...window.__scheduleFixture.status })`)
        assert(await waitForCondition(`${body}.innerText.includes("Plan not verified") && !${body}.innerText.includes("Checking plan")`), "loaded MSP denial still shows Checking plan")
        assert(await evaluate(`${body}.innerText.includes("Your license does not cover Contoso 1 right now, so its automatic backups do not run.")`), "loaded MSP denial lost the coverage warning")
        assert(await evaluate(`!${doc}.querySelector('#schedule-frequency option[value="daily"]')`), "uncovered MSP tenant offers Daily")
      }
      await community()
      assert(await evaluate(`${doc}.querySelector('#schedule-frequency option[value="daily"]').disabled`), "Community offers Daily")
      assert(await evaluate(`${body}.innerText.includes('Every day (Pro)')`), "Community daily explanation missing")
      await setValue("schedule-time", "07:45")
      assert(await waitForCondition(`!${doc}.getElementById('schedule-time-error') && !${doc}.getElementById('schedule-time').hasAttribute('aria-invalid') && !${doc}.getElementById('schedule-time').hasAttribute('aria-describedby')`), "corrected time kept its error")
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Schedule saved')`), "enabled schedule success message missing")
      assert(await evaluate(`window.__scheduleFixture.calls.length === 1 && window.__scheduleFixture.calls[0].weekday === 2`), "valid draft was not saved")
      assert(await waitForCondition(`${body}.innerText.includes('Background restart is not installed. Backups run while TenuVault is running.')`), "missing runner note absent from saved summary")
      assert(await evaluate(`${doc}.querySelector('label[for="schedule-weekday"]').textContent === 'Day' && ${doc}.querySelector('label[for="schedule-time"]').textContent.startsWith('Time (')`), "block field labels missing")
      const link = `[...${body}.querySelectorAll('a')].find(element => element.textContent === 'Settings > Background runner')`
      assert(await evaluate(`${link}?.getAttribute('href') === '#/portal/settings'`), "Settings link missing")
      await evaluate(`${link}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Background runner') && Boolean(${doc}.getElementById('settings-background'))`), "Settings link did not open the background section page")
    } finally {
      await close()
    }
  })

  await check("Community can pause an existing daily schedule with its saved summary intact", async () => {
    const originalCommunityTenant = (await evaluate(`window.tenuvault.license.status()`)).communityTenantId
    try {
      const schedules = await evaluate(`window.tenuvault.schedules.set({ tenantId: ${JSON.stringify(tenantId)}, enabled: true, frequency: 'daily', time: '07:45' })`)
      const current = schedules.find(schedule => schedule.tenantId === tenantId)
      await open(current, true)
      assert(await waitForCondition(`${body}.innerText.includes('Checking plan')`), "saved daily schedule lacks unknown plan state")
      assert(await evaluate(`!${doc}.querySelector('option[value="daily"]')`), "existing Daily offered while checking the plan")
      if (originalCommunityTenant) await evaluate(`window.tenuvault.license.releaseTenant(${JSON.stringify(originalCommunityTenant)})`)
      const status = await evaluate(`window.tenuvault.license.retry(${JSON.stringify(tenantId)})`)
      assert(status.communityTenantId === tenantId, "main-process Community seat does not belong to the schedule fixture")
      await community()
      assert(await evaluate(`${doc}.querySelector('#schedule-frequency option[value="daily"]').disabled`), "downgraded daily option is enabled")
      await evaluate(`${automatic}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Daily at 07:45') && !${doc}.getElementById('schedule-time')`), "pausing hid the saved recurrence summary")
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Automatic backups paused')`), "pause success message missing")
      const saved = await evaluate(`window.tenuvault.schedules.list()`)
      assert(saved.some(schedule => schedule.tenantId === tenantId && !schedule.enabled && schedule.frequency === 'daily' && schedule.time === '07:45'), "pausing changed the stored daily schedule")
      const refusal = await evaluate(`window.tenuvault.schedules.set({ tenantId: ${JSON.stringify(tenantId)}, enabled: true, frequency: 'daily', time: '07:45' }).then(() => null, error => error.message)`)
      assert(refusal === "PlanRequired: Daily scheduled backups: included in TenuVault Pro and MSP. Upgrade on the License page.", `Community daily re-enable did not return the PlanRequired message: ${JSON.stringify(refusal)}`)
      assert((await evaluate(`window.tenuvault.schedules.list()`)).some(schedule => schedule.tenantId === tenantId && !schedule.enabled), "refused daily re-enable changed the paused schedule")
      assert(await evaluate(`${body}.innerText.includes('Daily at 07:45')`), "paused recurrence summary missing")
      assert(await evaluate(`!${body}.innerText.includes('Background restart is not installed.')`), "installed runner shows the missing runner note")
      assert(await evaluate(`window.__scheduleFixture.runnerChecks === 1`), "runner status was polled")
      await screenshot("09b-schedule-daily-paused")
    } finally {
      await close()
      await evaluate(`window.tenuvault.license.releaseTenant(${JSON.stringify(tenantId)})`)
      if (originalCommunityTenant) {
        const restored = await evaluate(`window.tenuvault.license.retry(${JSON.stringify(originalCommunityTenant)})`)
        assert(restored.communityTenantId === originalCommunityTenant, "original Community seat was not restored")
      }
    }
  })
}
