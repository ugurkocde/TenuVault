import { describe, expect, it } from "vitest"
import { BlobWriter } from "../src/main/backup/blob-writer"

describe("BlobWriter.list", () => {
  it("sends back the continuation marker as the blob name it stands for, not XML-escaped", async () => {
    const markers: Array<string | null> = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const marker = new URL(String(input)).searchParams.get("marker")
      markers.push(marker)
      // The local emulator escapes names and markers alike; the next page starts at the marker.
      const body = marker === null
        ? `<EnumerationResults><Blobs><Blob><Name>A</Name></Blob></Blobs><NextMarker>A &amp; &lt;B&gt; &quot;C&quot;</NextMarker></EnumerationResults>`
        : marker === `A & <B> "C"`
          ? `<EnumerationResults><Blobs><Blob><Name>A &amp; &lt;B&gt; &quot;C&quot;</Name></Blob></Blobs><NextMarker /></EnumerationResults>`
          : `<EnumerationResults><Blobs></Blobs><NextMarker /></EnumerationResults>`
      return new Response(body, { status: 200 })
    }) as typeof fetch
    const writer = new BlobWriter(fetchImpl, "tvlocal-11111111-1111-1111-1111-111111111111", async () => "")

    expect((await writer.list("")).blobs).toEqual(["A", `A & <B> "C"`])
    expect(markers).toEqual([null, `A & <B> "C"`])
  })
})

describe("BlobWriter confirmed-missing reads", () => {
  const writer = (body: string) => new BlobWriter(async () => new Response(body, { status: 404 }), "stcontoso", async () => "token")
  it("reads the error code from a small XML body", async () => {
    expect(await writer("<Error><Code>BlobNotFound</Code></Error>").readJson("policy.json", true)).toBeNull()
  })
  it("does not confirm a miss from a proxy page that only mentions an Azure code", async () => {
    await expect(writer("<html><body><Error><Code>BlobNotFound</Code></Error></body></html>").readJson("policy.json", true)).rejects.toThrow()
    expect(await writer('<?xml version="1.0" encoding="utf-8"?>\n<Error><Code>ContainerNotFound</Code><Message>x</Message></Error>').readJson("policy.json", true)).toBeNull()
  })
  it("treats an oversized 404 body as unconfirmed instead of buffering it", async () => {
    const body = `<Error><Code>BlobNotFound</Code>${" ".repeat(70 * 1024)}</Error>`
    await expect(writer(body).readJson("policy.json", true)).rejects.toThrow()
  })
})
