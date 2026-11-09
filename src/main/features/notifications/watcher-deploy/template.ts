import templateText from "../../../../../resources/notifications/azuredeploy.json?raw"
import type { WatcherDeployPlan } from "../../../../shared/notifications/watcher-deploy"

export interface WatcherDeploymentValues {
  tenantName: string
  scheduleStartTime: string
  scheduleIntervalMinutes: number
  includeActor: boolean
  teamsWebhookUrl: string
  webhookUrl: string
  webhookSecret: string
  teamsCardLayout: string
}

/**
 * The first-deployment template, submitted from the app instead of the portal. It is used
 * only when no Automation account is there: its schedule link ids are deterministic GUIDs
 * Azure refuses to reuse, so this body is never sent over an existing watcher. Destination
 * values travel as securestring parameters and are never stored by the app afterwards.
 */
export function watcherDeploymentBody(plan: WatcherDeployPlan, values: WatcherDeploymentValues): Record<string, unknown> {
  const parameter = (value: string | number | boolean) => ({ value })
  return {
    properties: {
      mode: "Incremental",
      template: JSON.parse(templateText) as unknown,
      parameters: {
        tenantName: parameter(values.tenantName),
        storageAccountName: parameter(plan.storageAccountName),
        location: parameter(plan.location),
        automationAccountName: parameter(plan.automationAccountName),
        teamsWebhookUrl: parameter(values.teamsWebhookUrl),
        webhookUrl: parameter(values.webhookUrl),
        webhookSecret: parameter(values.webhookSecret),
        mailSender: parameter(""),
        mailRecipients: parameter(""),
        reportRecipients: parameter(""),
        mailProbeMailbox: parameter(""),
        alertEmail: parameter(plan.alertEmail),
        noFailureAlert: parameter(plan.noFailureAlert),
        includeConditionalAccess: parameter(plan.needsConditionalAccess),
        includeActor: parameter(values.includeActor),
        missedBackupHours: parameter(48),
        scheduleIntervalMinutes: parameter(values.scheduleIntervalMinutes),
        scheduleStartTime: parameter(values.scheduleStartTime),
        teamsCardLayout: parameter(values.teamsCardLayout),
      },
    },
  }
}

/** The template's allowed cadences, from the desktop checking interval. */
export function watcherScheduleInterval(minutes: number): number {
  if (minutes <= 15) return 15
  if (minutes <= 20) return 20
  if (minutes <= 30) return 30
  if (minutes <= 60) return 60
  if (minutes <= 120) return 120
  if (minutes <= 180) return 180
  return 240
}

/** An ARM schedule start time with an explicit offset, as the template asks for. */
export function scheduleStartTime(from: Date, minutesAhead = 20): string {
  return new Date(from.getTime() + minutesAhead * 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00")
}
