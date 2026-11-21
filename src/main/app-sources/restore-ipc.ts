import { withPlanError } from "../../shared/plan-errors"
import type { AppSourceService } from "./service"

export function appSourceRestoreHandler(service: AppSourceService) {
  return (_event: unknown, tenant: unknown, operation: unknown, source: unknown, target: unknown, name: unknown, settingsHash: unknown) =>
    withPlanError(() => service.restore(tenant, operation, source, target, name, settingsHash))
}
