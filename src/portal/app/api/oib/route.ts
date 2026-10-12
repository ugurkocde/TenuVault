import { FrameworkError } from "../../../../main/frameworks/service"
import { handleOib } from "../../../../main/oib/service"
import { record } from "../../../../shared/frameworks/policies"
import { TenantWriteConflict } from "../../../../main/features/write-lock"

export async function POST(request: Request): Promise<Response> {
  try {
    const text = await request.text()
    if (text.length > 1_000_000) return Response.json({ error: "The request is too large." }, { status: 413 })
    const body: unknown = JSON.parse(text)
    if (!record(body)) return Response.json({ error: "Expected an OpenIntuneBaseline request." }, { status: 400 })
    return Response.json(await handleOib(body))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OpenIntuneBaseline request failed." }, { status: error instanceof FrameworkError || error instanceof TenantWriteConflict ? error.status : 400 })
  }
}
