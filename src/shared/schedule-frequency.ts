export const HOURLY_INTERVALS = [4, 6, 12] as const

export type HourlyInterval = typeof HOURLY_INTERVALS[number]
export type ScheduleFrequency = "daily" | "weekly" | "hourly"

export function isHourlyInterval(value: unknown): value is HourlyInterval {
  return value === 4 || value === 6 || value === 12
}

export function isScheduleFrequency(value: unknown): value is ScheduleFrequency {
  return value === "weekly" || value === "daily" || value === "hourly"
}

/** Since every interval divides 24, a local day has the same set of wall-clock hours. */
export function hoursInDay(anchorHour: number, interval: HourlyInterval): number[] {
  return Array.from({ length: 24 / interval }, (_, index) => anchorHour % interval + index * interval)
}
