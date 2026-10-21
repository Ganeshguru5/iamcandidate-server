import { compileLatex } from "../lib/latex"
import { ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import { compileLatexInput } from "../schemas/documents"

/** Compile only — saving the PDF reuses the normal document upload flow. */
export const latexRoutes: Routes = {
  "POST /latex/compile": async (ctx) => {
    const { source } = validate(compileLatexInput, ctx.body, "request body")
    const { pdf, log } = await compileLatex(source)
    return ok({ pdfBase64: pdf.toString("base64"), sizeBytes: pdf.byteLength, log })
  },
}
