import { expect, it } from "vitest"
import { handleFramework, isAdmittedAssessStatus, listAssessJobs } from "../src/main/frameworks/service"

const post = (body: object, path = "/api/frameworks") =>
  new Request(`https://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

it("lists assessment job summaries without a tenant or token", async () => {
  await expect(handleFramework({ action: "assess-jobs" })).resolves.toEqual({ jobs: listAssessJobs() })
})

it("admits assess-jobs polls past the plan guard like admitted status polls", async () => {
  await expect(isAdmittedAssessStatus(post({ action: "assess-jobs" }))).resolves.toBe(true)
  await expect(isAdmittedAssessStatus(post({ action: "assess-jobs" }, "/api/oib"))).resolves.toBe(false)
  await expect(isAdmittedAssessStatus(post({ action: "assess-start" }))).resolves.toBe(false)
})
