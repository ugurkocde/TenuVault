export async function checkIdentityRestoreSafety({ check, evaluate, waitForCondition, screenshot, assert, send, go }) {
  await check("identity restore safety stays readable in both themes at 1024 pixels", async () => {
    await evaluate(`(() => {
      window.__identityOriginalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (String(input) === '/api/restore-journal') return Promise.resolve(Response.json({ records: [] }));
        if (String(input) !== '/api/restore-safety') return window.__identityOriginalFetch(input, init);
        return Promise.resolve(Response.json({accountIds: ['00000000-0000-4000-8000-000000000007'], runs: [{id:'00000000-0000-4000-8000-000000000026', origin:'restore', entries:[{key:'one', folder:'AuthorizationPolicy', state:'uncertain', reason:'The unanswered write could not be uniquely reconciled.'}], replacedReferences:[{path:'ConditionalAccessPolicies/remote-access', property:'conditions.users.excludeUsers', mapping:{kind:'objectId',source:'00000000-0000-4000-8000-000000000008',target:'00000000-0000-4000-8000-000000000009'}}]}]}));
      };
    })()`)
    try {
      await go("#/portal/settings?section=storage", "Identity restore safety")
      assert(await waitForCondition(`document.body.innerText.includes('ConditionalAccessPolicies/remote-access')`), "saved reference report was not shown")
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 1100, deviceScaleFactor: 1, mobile: false })
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark}); [...document.querySelectorAll('[data-slot="card"]')].find(card => card.textContent.includes('Identity restore safety'))?.scrollIntoView({block:'start'})`)
        // Card implementations without data-slot still expose their heading.
        await evaluate(`[...document.querySelectorAll('h3, div')].find(element => element.textContent === 'Identity restore safety')?.scrollIntoView({block:'start'})`)
        assert(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), "identity safety overflowed at 1024 pixels")
        assert(await evaluate(`!![...document.querySelectorAll('button')].find(button => button.textContent === 'Read back saved outcome')`), "read-back action missing")
        await screenshot(`identity-restore-safety-${dark ? 'dark' : 'light'}`)
      }
    } finally {
      await evaluate(`window.fetch = window.__identityOriginalFetch; delete window.__identityOriginalFetch; document.documentElement.classList.remove('dark')`)
      await send("Emulation.clearDeviceMetricsOverride")
      await go("#/portal/tenants", "Tenants")
    }
  })
}
