/**
 * Runs a tray backup for every connected tenant, one tenant at a time like the scheduler.
 * Each backup reads with its own concurrency, so running every tenant at once would multiply
 * the Graph requests and throttle the machine into failures. A tenant that fails does not
 * stop the remaining tenants.
 */
export async function runTrayBackups(tenantIds: readonly string[], run: (tenantId: string) => Promise<unknown>): Promise<void> {
  for (const tenantId of tenantIds) {
    try {
      await run(tenantId)
    } catch {
      // The run already reports its own failure; the next tenant still gets its backup.
    }
  }
}
