import type { FeatureDeps } from "../deps"
import { FeatureError, optionalText, text, type ActionHandler, type Body } from "../route"
import { applyChangeSet, approveChangeSet, createRollbackChangeSet, getChangeSet, previewChangeSet, previewRollback, rejectChangeSet } from "../change-sets/engine"

const uuid = (body: Body, key: string): string => {
  const id = text(body, key, 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError(`Invalid ${key}`)
  return id
}

const hashField = (body: Body, key: string): string => {
  const value = body[key]
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new FeatureError(`${key} is required`)
  return value
}

/**
 * Review, apply and rollback actions for the change sets one workflow created, served from that
 * workflow's own route. Each call names the workflow record (`id`) and the change set
 * (`changeSetId`); the change set must have been created by this workflow for this record
 * (rollbacks keep the origin), so a route never reviews or applies another workflow's writes.
 * The engine enforces the rest: approval bound to content and target state, pre-change backup,
 * journaled writes, read-back and explicit confirmation.
 *
 * `sync` runs after every state change so the workflow record reflects the outcome.
 */
export function changeSetActions(deps: FeatureDeps, options: { prefix: string; workflow: string; exists: (tenantId: string, id: string) => void; sync: (tenantId: string, id: string) => unknown }): Record<string, ActionHandler> {
  const owned = (tenantId: string, body: Body) => {
    const id = uuid(body, "id")
    options.exists(tenantId, id)
    const changeSet = getChangeSet(deps, tenantId, uuid(body, "changeSetId"))
    if (changeSet.origin.workflow !== options.workflow || changeSet.origin.recordId !== id) throw new FeatureError("This change set does not belong to this record.", 404)
    return { id, changeSet }
  }
  const done = (tenantId: string, id: string, changeSetId: string) => ({ record: options.sync(tenantId, id), changeSet: getChangeSet(deps, tenantId, changeSetId) })
  const p = options.prefix
  return {
    [`${p}change-preview`]: async ({ tenantId, body }) => previewChangeSet(deps, tenantId, owned(tenantId, body).changeSet.id),
    [`${p}change-approve`]: async ({ tenantId, body, actor }) => {
      const { id, changeSet } = owned(tenantId, body)
      await approveChangeSet(deps, tenantId, changeSet.id, { contentHash: hashField(body, "contentHash"), targetFingerprint: hashField(body, "targetFingerprint"), reviewer: optionalText(body, "reviewer", 200), note: optionalText(body, "note", 2000) }, actor)
      return done(tenantId, id, changeSet.id)
    },
    [`${p}change-reject`]: async ({ tenantId, body, actor }) => {
      const { id, changeSet } = owned(tenantId, body)
      await rejectChangeSet(deps, tenantId, changeSet.id, { reviewer: optionalText(body, "reviewer", 200), note: optionalText(body, "note", 2000) }, actor)
      return done(tenantId, id, changeSet.id)
    },
    /** Applies an approved change set (or a rollback), or retries one that ended partial, failed or uncertain. */
    [`${p}change-apply`]: async ({ tenantId, body, actor }) => {
      const { id, changeSet } = owned(tenantId, body)
      await applyChangeSet(deps, tenantId, changeSet.id, { contentHash: hashField(body, "contentHash"), confirmed: body.confirm === true }, actor)
      return done(tenantId, id, changeSet.id)
    },
    [`${p}change-rollback-preview`]: async ({ tenantId, body }) => previewRollback(deps, tenantId, owned(tenantId, body).changeSet.id),
    [`${p}change-rollback-create`]: async ({ tenantId, body, actor }) => {
      const { id, changeSet } = owned(tenantId, body)
      const rollback = await createRollbackChangeSet(deps, tenantId, changeSet.id, { title: optionalText(body, "title", 200), ticket: optionalText(body, "ticket", 200) }, actor)
      return { record: options.sync(tenantId, id), changeSet: rollback }
    },
  }
}
