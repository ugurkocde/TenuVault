import type { BackupSchedule, ScheduleInput } from "../../shared/ipc"
import { PlanRequired, type Plan } from "../../shared/plans"

/** Pausing keeps the saved configuration, even after a plan downgrade. */
export function prepareScheduleInput(input: ScheduleInput, plan: Plan | null, current?: BackupSchedule): ScheduleInput {
  if (!input.enabled && current) {
    return {
      tenantId: current.tenantId,
      enabled: false,
      frequency: current.frequency,
      time: current.time,
      weekday: current.weekday,
    }
  }
  if (input.enabled && input.frequency === "daily" && plan === "community") throw new PlanRequired("dailySchedule")
  return input
}
