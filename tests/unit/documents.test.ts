import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"

import { handler } from "../../src/functions/documents"
import type { DocumentFile } from "../../src/models"
import { call } from "../support/http"
import { testState } from "../support/setup"

interface UploadTicket {
  documentId: string
  uploadKey: string
  uploadUrl: string
  method: string
  headers: Record<string, string>
  expiresIn: number
}

async function requestUpload(body: Record<string, unknown> = {}) {
  return call<UploadTicket>(handler, "POST", "/documents/upload-url", {
    body: { fileName: "My Resume.pdf", contentType: "application/pdf", sizeBytes: 1024, ...body },
  })
}

function stubS3Object(sizeBytes: number | undefined) {
  const sent: unknown[] = []
  testState.s3Send = async (command) => {
    sent.push(command)
    if (command instanceof HeadObjectCommand) {
      if (sizeBytes === undefined) {
        const error = new Error("Not Found")
        error.name = "NotFound"
        throw error
      }
      return { ContentLength: sizeBytes, ContentType: "application/pdf" }
    }
    return {}
  }
  return sent
}

describe("document upload URL", () => {
  it("returns a short-lived presigned PUT URL scoped to the user's prefix", async () => {
    const res = await requestUpload()
    expect(res.status).toBe(201)
    const ticket = res.body.data as UploadTicket

    expect(ticket.documentId).toMatch(/^doc_[a-f0-9]{16}$/)
    expect(ticket.uploadKey).toBe(`users/usr_test/documents/${ticket.documentId}/My Resume.pdf`)
    expect(ticket.method).toBe("PUT")
    expect(ticket.headers).toEqual({ "Content-Type": "application/pdf" })

    const url = new URL(ticket.uploadUrl)
    expect(url.hostname).toBe("personal-os-documents-test.s3.ap-south-1.amazonaws.com")
    expect(decodeURIComponent(url.pathname)).toBe(`/${ticket.uploadKey}`)
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300")
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/)
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("host")
    // Browsers can't send the SDK's default checksum; it must not be signed in.
    expect(url.search.toLowerCase()).not.toContain("checksum")
  })

  it("sanitizes file names in object keys", async () => {
    const res = await requestUpload({ fileName: "résumé<v2>?.pdf" })
    expect(res.body.data?.uploadKey).toMatch(/\/r_sum_v2_\.pdf$/)
  })

  it("rejects oversize files, unsupported types and path traversal", async () => {
    expect((await requestUpload({ sizeBytes: 26 * 1024 * 1024 })).status).toBe(400)
    expect((await requestUpload({ contentType: "application/x-msdownload" })).status).toBe(400)
    expect((await requestUpload({ fileName: "../../etc/passwd" })).status).toBe(400)
  })
})

describe("document metadata", () => {
  async function upload() {
    const ticket = (await requestUpload()).body.data as UploadTicket
    stubS3Object(2048)
    const res = await call<DocumentFile>(handler, "POST", "/documents", {
      body: {
        uploadKey: ticket.uploadKey,
        name: "My Resume.pdf",
        category: "resume",
        kind: "pdf",
        sizeBytes: 1,
      },
    })
    return { ticket, res }
  }

  it("saves metadata after verifying the object in S3 (size taken from S3)", async () => {
    const { ticket, res } = await upload()
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      id: ticket.documentId,
      name: "My Resume.pdf",
      sizeBytes: 2048,
      mimeType: "application/pdf",
      starred: false,
      source: "local",
    })
    expect(res.body.data).not.toHaveProperty("s3Key")
  })

  it("rejects confirmation when nothing was uploaded", async () => {
    const ticket = (await requestUpload()).body.data as UploadTicket
    stubS3Object(undefined)
    const res = await call(handler, "POST", "/documents", {
      body: {
        uploadKey: ticket.uploadKey,
        name: "a.pdf",
        category: "other",
        kind: "pdf",
        sizeBytes: 1,
      },
    })
    expect(res.status).toBe(400)
  })

  it("rejects keys outside the caller's prefix", async () => {
    stubS3Object(10)
    const res = await call(handler, "POST", "/documents", {
      body: {
        uploadKey: "users/someone-else/documents/doc_0123456789abcdef/a.pdf",
        name: "a.pdf",
        category: "other",
        kind: "pdf",
        sizeBytes: 1,
      },
    })
    expect(res.status).toBe(400)
  })

  it("returns 409 when the same upload is confirmed twice", async () => {
    const { ticket } = await upload()
    const again = await call(handler, "POST", "/documents", {
      body: {
        uploadKey: ticket.uploadKey,
        name: "x.pdf",
        category: "resume",
        kind: "pdf",
        sizeBytes: 1,
      },
    })
    expect(again.status).toBe(409)
  })

  it("renames, toggles star, signs downloads and deletes the S3 object", async () => {
    const { ticket } = await upload()
    const id = ticket.documentId

    const renamed = await call<DocumentFile>(handler, "PUT", `/documents/${id}`, {
      body: { name: "CV.pdf" },
    })
    expect(renamed.body.data?.name).toBe("CV.pdf")

    const starred = await call<DocumentFile>(handler, "POST", `/documents/${id}/toggle-star`)
    expect(starred.body.data?.starred).toBe(true)

    const download = await call<{ url: string }>(handler, "GET", `/documents/${id}/download-url`)
    const url = new URL(download.body.data?.url as string)
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="CV.pdf"',
    )

    const sent = stubS3Object(0)
    expect((await call(handler, "DELETE", `/documents/${id}`)).status).toBe(204)
    expect(sent.some((c) => c instanceof DeleteObjectCommand)).toBe(true)
    expect((await call(handler, "GET", `/documents/${id}`)).status).toBe(404)
  })
})
