import { FrameworkError, handleFramework } from "../../../../main/frameworks/service"
import { record } from "../../../../shared/frameworks/policies"
import { handleNativeFramework } from "../../../../main/frameworks/native"
import { TenantWriteConflict } from "../../../../main/features/write-lock"

export async function POST(request: Request): Promise<Response> {
  try {
    const text = await request.text()
    if (text.length > 8_500_000) return Response.json({ error: "The policy pack exceeds 8 MB." }, { status: 413 })
    const body: unknown = JSON.parse(text)
    if (!record(body)) return Response.json({ error: "Expected a framework request." }, { status: 400 })
    if (typeof body.action === "string" && body.action.startsWith("native-")) return await handleNativeFramework(body)
    return Response.json(await handleFramework(body))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Framework request failed." }, { status: error instanceof FrameworkError || error instanceof TenantWriteConflict ? error.status : 400 })
  }
}
