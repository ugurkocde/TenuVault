/** Exercise the built schedule editor with controlled license and runner responses. */
export async function checkSchedulePanel({ check, evaluate, waitForCondition, waitForTrialHealth, screenshot, assert }) {
  const tenantId = "11111111-1111-1111-1111-111111111111"
  const weeklyNote = "A weekly schedule can leave up to six days of changes unprotected. Daily backups are included in Pro."
  const doc = "window.__scheduleFrame.contentDocument"
  const body = `${doc}.body`
  // The Schedule tab has a Save button per card (storage dialog, "What to back up", the schedule
  // itself); pick the one inside the Automatic backups card, not the first on the page.
  const save = `[...${body}.querySelectorAll("button")].find(button => button.textContent.trim() === "Save" && button.closest("div.rounded-3xl")?.querySelector("h2")?.textContent === "Automatic backups")`
  const automatic = `[...${body}.querySelectorAll("label")].find(label => label.textContent.includes("automatically"))?.querySelector('input[type="checkbox"]')`

  async function open(current = null, installed = false) {
    await waitForTrialHealth()
    await evaluate(`(async () => {
      const status = window.__smokeTrialStatus
      window.__scheduleFixture = { calls: [], links: [], runnerChecks: 0, status: { ...status, tenants: [] } }
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
          open: (target, options) => { window.__scheduleFixture.links.push({ target, ...options }); return Promise.resolve() },
          onChanged: listener => {
            window.__scheduleFixture.planChanged = listener
            return () => { window.__scheduleFixture.planChanged = null }
          },
        },
        auth: {
          ...window.tenuvault.auth,
          signIn: () => window.tenuvault.license.checkNewTenant("44444444-4444-4444-4444-444444444444"),
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
            if (!schedules.planError) window.__scheduleFixture.scheduleChanged(schedules)
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
      const style = frame.contentDocument.createElement("style")
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }"
      frame.contentDocument.head.appendChild(style)
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
      assert(await evaluate(`!${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "unknown plan shows the weekly consequence")
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
      assert(await waitForCondition(`${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "enabled Community weekly schedule consequence missing")
      assert(await evaluate(`(() => {
        const line = [...${body}.querySelectorAll('p')].find(element => element.textContent === ${JSON.stringify(weeklyNote)})
        return line?.className === 'text-sm text-gray-500' && ![...line.parentElement.querySelectorAll('button')].some(button => button.textContent.includes('See plans'))
      })()`), "weekly consequence is not a plain muted line")
      assert(await evaluate(`!${body}.innerText.includes('Daily scheduled backups: included in TenuVault Pro and MSP.')`), "weekly selection shows the daily upgrade note")
      await evaluate(`${automatic}.click()`)
      assert(await waitForCondition(`!${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "disabled weekly draft shows the consequence")
      await evaluate(`${automatic}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "enabled weekly draft lost the consequence")
      await setValue("schedule-time", "07:45")
      assert(await waitForCondition(`!${doc}.getElementById('schedule-time-error') && !${doc}.getElementById('schedule-time').hasAttribute('aria-invalid') && !${doc}.getElementById('schedule-time').hasAttribute('aria-describedby')`), "corrected time kept its error")
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Schedule saved')`), "enabled schedule success message missing")
      assert(await evaluate(`window.__scheduleFixture.calls.length === 1 && window.__scheduleFixture.calls[0].weekday === 2`), "valid draft was not saved")
      assert(await waitForCondition(`${body}.innerText.includes('Background restart is not installed. Backups run while TenuVault is running.')`), "missing runner note absent from saved summary")
      assert(await evaluate(`${doc}.querySelector('label[for="schedule-weekday"]').textContent === 'Day' && ${doc}.querySelector('label[for="schedule-time"]').textContent.startsWith('Time (')`), "block field labels missing")
      for (const plan of ['pro', 'msp']) {
        await evaluate(`window.__scheduleFixture.planChanged({ ...window.__scheduleFixture.status, tenants: [{ tenantId: ${JSON.stringify(tenantId)}, plan: ${JSON.stringify(plan)}, entitled: true }] })`)
        assert(await waitForCondition(`!${doc}.querySelector('#schedule-frequency option[value="daily"]').disabled`), `${plan} plan did not load`)
        assert(await evaluate(`!${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), `${plan} shows the weekly consequence`)
      }
      await community()
      assert(await waitForCondition(`${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "saved enabled weekly schedule lost the consequence")
      await evaluate(`${automatic}.click()`)
      assert(await waitForCondition(`!${doc}.getElementById('schedule-frequency')`), "weekly draft did not pause")
      assert(await evaluate(`${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "saved enabled weekly schedule lost the consequence before pausing was saved")
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Automatic backups paused') && !${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "paused saved weekly schedule shows the consequence")
      const link = `[...${body}.querySelectorAll('a')].find(element => element.textContent === 'Settings > Background runner')`
      assert(await evaluate(`${link}?.getAttribute('href') === '#/portal/settings?section=background'`), "Settings link missing")
      await evaluate(`${link}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Background runner') && Boolean(${doc}.getElementById('settings-background'))`), "Settings link did not open the background section page")
    } finally {
      await close()
    }
  })

  await check("Community can pause an existing daily schedule with its saved summary intact", async () => {
    const settled = await waitForTrialHealth()
    const tenantTrialsEnabled = settled.tenantTrialsEnabled
    console.log(`     trial switch: ${tenantTrialsEnabled ? "enabled, Buy Pro in plan dialogs" : "disabled, emailed trial link in plan dialogs"}`)
    const originalCommunityTenant = settled.communityTenantId
    try {
      const schedules = await evaluate(`window.tenuvault.schedules.set({ tenantId: ${JSON.stringify(tenantId)}, enabled: true, frequency: 'daily', time: '07:45' })`)
      const current = schedules.find(schedule => schedule.tenantId === tenantId)
      await open(current, true)
      assert(await waitForCondition(`${body}.innerText.includes('Checking plan')`), "saved daily schedule lacks unknown plan state")
      assert(await evaluate(`!${doc}.querySelector('option[value="daily"]')`), "existing Daily offered while checking the plan")
      if (originalCommunityTenant) await evaluate(`window.tenuvault.license.releaseTenant(${JSON.stringify(originalCommunityTenant)})`)
      let status = await evaluate(`window.tenuvault.license.retry(${JSON.stringify(tenantId)})`)
      if (status.communityChoiceTenantIds?.includes(tenantId)) status = await evaluate(`window.tenuvault.license.chooseCommunity(${JSON.stringify(tenantId)})`)
      assert(status.communityTenantId === tenantId, "main-process Community seat does not belong to the schedule fixture")
      await community()
      assert(await evaluate(`${doc}.querySelector('#schedule-frequency option[value="daily"]').disabled`), "downgraded daily option is enabled")
      assert(await evaluate(`${body}.innerText.includes('Daily scheduled backups: included in TenuVault Pro and MSP.')`), "existing daily upgrade note missing")
      assert(await evaluate(`!${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "daily schedule shows the weekly consequence")
      await evaluate(`${automatic}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('at 07:45') && !${doc}.getElementById('schedule-time')`), "pausing hid the saved recurrence summary")
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Automatic backups paused')`), "pause success message missing")
      const saved = await evaluate(`window.tenuvault.schedules.list()`)
      assert(saved.some(schedule => schedule.tenantId === tenantId && !schedule.enabled && schedule.frequency === 'daily' && schedule.time === '07:45'), "pausing changed the stored daily schedule")
      const resumed = await evaluate(`window.tenuvault.schedules.set({ tenantId: ${JSON.stringify(tenantId)}, enabled: true, frequency: 'daily', time: '07:45' })`)
      assert(!resumed.planError && resumed.some(schedule => schedule.tenantId === tenantId && schedule.enabled && schedule.frequency === 'daily'), "Community could not resume its saved daily schedule")
      await evaluate(`window.tenuvault.schedules.set({ tenantId: ${JSON.stringify(tenantId)}, enabled: false, frequency: 'daily', time: '07:45' })`)
      assert(await evaluate(`${body}.innerText.includes('at 07:45 on Community')`), "paused recurrence summary missing")
      assert(await evaluate(`${body}.innerText.includes('Daily scheduled backups: included in TenuVault Pro and MSP.') && !${body}.innerText.includes(${JSON.stringify(weeklyNote)})`), "paused daily schedule changed its plan notes")
      assert(await evaluate(`!${body}.innerText.includes('Background restart is not installed.')`), "installed runner shows the missing runner note")
      assert(await evaluate(`window.__scheduleFixture.runnerChecks === 1`), "runner status was polled")
      await screenshot("09b-schedule-daily-paused")
      await evaluate(`${automatic}.click()`)
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.innerText.includes('Daily scheduled backups: included in TenuVault Pro and MSP.')`), "daily plan explanation missing")
      assert(await evaluate(`!${body}.querySelector('[role="dialog"]')`), "inline plan note opened a second dialog")
      await evaluate(`window.__scheduleFixture.planChanged({ ...window.__scheduleFixture.status, tenants: [{ tenantId: ${JSON.stringify(tenantId)}, plan: 'pro', entitled: true }] })`)
      assert(await waitForCondition(`!${doc}.querySelector('#schedule-frequency option[value="daily"]').disabled`), "Pro fixture was not applied")
      await evaluate(`window.tenuvault.schedules.set({ tenantId: ${JSON.stringify(tenantId)}, enabled: true, frequency: 'weekly', weekday: 1, time: '07:45' })`)
      await setValue("schedule-time", "09:00")
      await evaluate(`${save}.click()`)
      assert(await waitForCondition(`${body}.querySelector('[role="dialog"]')?.innerText.includes('Included in TenuVault Pro and MSP')`), "schedule refusal did not open the plan dialog")
      if (tenantTrialsEnabled) {
        assert(await evaluate(`[...${body}.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.trim() === 'Buy Pro')`), "plan dialog does not offer Buy Pro")
        assert(await evaluate(`!${body}.querySelector('[role="dialog"] input[type="email"]') && ![...${body}.querySelectorAll('[role="dialog"] a, [role="dialog"] button')].some(item => ['Start free trial', 'Start 30 day free trial'].includes(item.textContent.trim()))`), "plan dialog offers emailed trials with tenant trials enabled")
      } else {
        // Without a license on this machine, the plan dialog offers the no-card trial on the License page.
        assert(await evaluate(`[...${body}.querySelectorAll('[role="dialog"] a')].some(link => link.textContent.trim() === 'Start 30 day free trial' && link.getAttribute('href')?.endsWith('/license'))`), "plan dialog does not offer the trial")
      }
      assert(await evaluate(`![...${body}.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.trim() === 'See plans')`), "plan dialog offers the plans instead of the trial")
      await screenshot("09c-schedule-plan-dialog")
      await evaluate(`[...${body}.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === 'Close').click()`)
      const openSecondTenantDialog = async () => {
        await evaluate(`window.__scheduleFrame.contentWindow.location.hash = '#/portal/onboarding'`)
        // The second time the onboarding page may already be on its sign-in step.
        assert(await waitForCondition(`[...${body}.querySelectorAll('button')].some(button => ['I already have an app registration', 'Sign in with Microsoft'].includes(button.textContent.trim()))`), "onboarding fixture did not open")
        await evaluate(`[...${body}.querySelectorAll('button')].find(button => button.textContent.trim() === 'I already have an app registration')?.click()`)
        await setValue("tenant", "44444444-4444-4444-4444-444444444444")
        await setValue("clientId", "22222222-2222-2222-2222-222222222222")
        await evaluate(`[...${body}.querySelectorAll('button')].find(button => button.textContent.trim() === 'Sign in with Microsoft').click()`)
        assert(await waitForCondition(`${body}.querySelector('[role="dialog"]')?.innerText.includes('Community covers one tenant, and it is used for Contoso 1.')`), "Community dialog did not resolve the existing tenant name")
      }
      await openSecondTenantDialog()
      await screenshot("09d-community-tenant-dialog")
      if (tenantTrialsEnabled) {
        const linksBefore = await evaluate(`window.__scheduleFixture.links.length`)
        assert(await evaluate(`![...${body}.querySelectorAll('[role="dialog"] a')].some(link => link.textContent.trim() === 'Start 30 day free trial')`), "second tenant dialog offers an emailed trial")
        await evaluate(`[...${body}.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === 'Buy Pro').click()`)
        assert(await waitForCondition(`window.__scheduleFixture.links.length === ${linksBefore + 1}`), "second tenant Buy Pro did not open the checkout")
        assert(await evaluate(`window.__scheduleFixture.links.at(-1).target === 'checkout' && window.__scheduleFixture.links.at(-1).source === 'second-tenant'`), "second tenant Buy Pro used the wrong destination or source")
        await evaluate(`[...${body}.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === 'Not now').click()`)
      } else {
        // The trial starts on the License page, in the app, without a browser.
        const linksBefore = await evaluate(`window.__scheduleFixture.links.length`)
        await evaluate(`[...${body}.querySelectorAll('[role="dialog"] a, [role="dialog"] button')].find(item => item.textContent.trim() === 'Start 30 day free trial').click()`)
        assert(await waitForCondition(`${body}.innerText.includes('Try Pro free for 30 days, no card needed.') && !${body}.querySelector('[role="dialog"]')`), "second tenant trial did not open the trial form on the License page")
        assert(await evaluate(`window.__scheduleFixture.links.length === ${linksBefore}`), "second tenant trial opened a browser page")
      }
      await openSecondTenantDialog()
      await evaluate(`[...${body}.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === 'Add a license key').click()`)
      assert(await waitForCondition(`${body}.innerText.includes('License key') && !${body}.querySelector('[role="dialog"]')`), "Add a license key did not open the License page")

    } finally {
      await close()
      await evaluate(`window.tenuvault.license.releaseTenant(${JSON.stringify(tenantId)})`)
      if (originalCommunityTenant) {
        let restored = await evaluate(`window.tenuvault.license.retry(${JSON.stringify(originalCommunityTenant)})`)
        const choices = restored.communityChoiceTenantIds ?? []
        const selected = originalCommunityTenant
        if (restored.communityTenantId !== selected) {
          assert(choices.includes(selected), "Original Community tenant is not eligible. Refusing to move the Community seat.")
          restored = await evaluate(`window.tenuvault.license.chooseCommunity(${JSON.stringify(selected)})`)
        }
        assert(restored.communityTenantId === selected, "Community coverage was not restored after the fixture")
      } else {
        assert((await evaluate(`window.tenuvault.license.status()`)).communityTenantId === null, "The fixture left a Community seat claimed on an originally unclaimed install")
      }
    }
  })
}
