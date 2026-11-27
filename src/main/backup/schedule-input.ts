import type { BackupSchedule, ScheduleInput } from "../../shared/ipc"
import { isHourlyInterval, isScheduleFrequency } from "../../shared/schedule-frequency"
import { PlanRequired, type Plan } from "../../shared/plans"

export function scheduleNeedsPro(input: ScheduleInput, current?: ScheduleInput): boolean {
  return input.frequency !== "weekly" && (input.frequency !== current?.frequency || (input.frequency === "hourly" && input.intervalHours !== current.intervalHours))
}

export function validateScheduleFrequency(input: ScheduleInput): void {
  if (!isScheduleFrequency(input.frequency)) throw new Error("Choose a backup frequency.")
  if (input.frequency === "hourly" ? !isHourlyInterval(input.intervalHours) : input.intervalHours !== undefined) {
    throw new Error("Choose an interval of 4, 6, or 12 hours for an hourly schedule.")
  }
}

/** Pausing keeps the saved configuration, even after a plan downgrade. */
export function prepareScheduleInput(input: ScheduleInput, plan: Plan | null, current?: BackupSchedule): ScheduleInput {
  if (!input.enabled && current) {
    return {
      tenantId: current.tenantId,
      enabled: false,
      frequency: current.frequency,
      intervalHours: current.intervalHours,
      time: current.time,
      weekday: current.weekday,
    }
  }
  validateScheduleFrequency(input)
  if ((plan === "community" || (plan === null && input.frequency === "hourly")) && scheduleNeedsPro(input, current)) throw new PlanRequired("dailySchedule")
  return input
}
