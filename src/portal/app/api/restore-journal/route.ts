import { removeWrite, saveWrite, writeRecords, authorizeRestoreJournal } from '../../../../main/storage/restore-journal'
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as { tenantId?: string; action?: string; key?: string; confirmed?: boolean; objectId?: string } | null
  if (!body || typeof body.tenantId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.tenantId)) return Response.json({ error: 'Select a tenant for restore history.' }, { status: 400 })
  const tenantId = body.tenantId.toLowerCase()
  try { await authorizeRestoreJournal(tenantId) }
  catch { return Response.json({ error: 'Sign in with a license and management access to this tenant before viewing or changing restore history.' }, { status: 403 }) }
  const scopedRecords = () => writeRecords().filter(record => record.tenant.toLowerCase() === tenantId)
  if (body.action === 'list') return Response.json({ records: scopedRecords() })
  if (body.confirmed !== true || typeof body.key !== 'string') return Response.json({ error: 'Review the write in Intune and confirm reconciliation.' }, { status: 400 })
  const record = scopedRecords().find(entry => entry.key === body.key)
  if (body.action === 'new-operation') {
    if (!record || record.state !== 'reconciled') return Response.json({ error: 'Only reconciled writes can be cleared for a new operation.' }, { status: 409 })
    removeWrite(record.key)
    return Response.json({ records: scopedRecords() })
  }
  if (!record || (record.state !== 'uncertain' && !(record.state === 'reconciled' && body.action === 'applied'))) return Response.json({ error: 'The uncertain write no longer exists.' }, { status: 409 })
  if (body.action === 'not-applied') removeWrite(record.key)
  else if (body.action === 'applied' && typeof body.objectId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(body.objectId)) saveWrite({ ...record, state: 'reconciled', at: new Date().toISOString(), objectId: body.objectId })
  else return Response.json({ error: 'Supply the ID of the object confirmed in Intune.' }, { status: 400 })
  return Response.json({ records: scopedRecords() })
}
