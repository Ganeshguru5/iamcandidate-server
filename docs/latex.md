# LaTeX resumes

Resumes can be **form-based** (the original editor) or **LaTeX**. A LaTeX resume stores its
source on the resume (`format: "latex"`, `latexSource`). The editor compiles it to PDF on the
server with [Tectonic](https://tectonic-typesetting.github.io/) — a free, open-source,
self-contained XeLaTeX distribution that fetches packages on demand and caches them.

```
Editor (CodeMirror) ──Ctrl+S──► PUT /resumes/{id} { latexSource }   (saves, bumps version)
        └──────────────────────► POST /latex/compile { source } → { pdfBase64, sizeBytes, log }
"Save PDF to Documents" → compile → presigned upload (category "resume") → resume.documentId
```

Compile errors return **400 `COMPILE_ERROR`** with `details: { line?, log }`; the editor shows
"Line N: message" with **Go to line** and the full log.

## Local setup

`npm run dev` uses `iamcandidate-server/.tools/tectonic/tectonic(.exe)` if present, otherwise
`tectonic` on PATH. Install it once:

- **Windows:** download `tectonic-0.17.0-x86_64-pc-windows-msvc.zip` from the
  [releases page](https://github.com/tectonic-typesetting/tectonic/releases) and unzip
  `tectonic.exe` into `iamcandidate-server/.tools/tectonic/`.
- **macOS:** `brew install tectonic` · **Linux:** use the `x86_64-unknown-linux-musl` release.

The package cache lives in `iamcandidate-server/.tools/tectonic-cache` (dev server). The **first
compile downloads ~40 MB of LaTeX packages and can take a few minutes**; afterwards compiles
take 1–3 s. Locally the time limit is 5 minutes (`LATEX_TIMEOUT_MS`), in AWS 45 s.

Override with `TECTONIC_PATH`, `TECTONIC_CACHE_DIR` and `LATEX_TIMEOUT_MS`.

## AWS

`LatexFunction` is a **container image** (`latex/Dockerfile`): Node handler + Tectonic + a
package cache pre-warmed by compiling `latex/starter-resume.tex` at build time (copied to
`/tmp` on cold start). `sam build` needs Docker for this one function, and `sam deploy`
pushes the image to an ECR repository it creates (`resolve_image_repos = true`).

### Isolation

LaTeX can read any file the compiler process can (`\input{/abs/path}` works even in
Tectonic's `--untrusted` mode). So the compiler:

- runs in its own Lambda with **no secrets** (AUTH_SECRET, encryption key and Google secret are
  blanked) and **no IAM permissions beyond logging** — no DynamoDB, no S3;
- is protected by `SessionAuthorizerFunction`, an API Gateway Lambda authorizer that checks
  the session token (no caching, so disabled users are rejected at once);
- gets a minimal environment and a fresh working directory per compile, no stdin, a time
  limit and a 4 MB PDF limit;
- runs with `--untrusted` (no shell escape).

Residual risk: compiles share a warm container's `/tmp` package cache, so a crafted document
could in theory tamper with cached packages for later compiles in that container. For a
personal, admin-managed user base this is acceptable; for an open multi-tenant service, use
one container per user or a read-only cache.

With `npm run dev` the compiler runs on your own machine as you; only give accounts to people
you trust there.

## Starter template

`latex/starter-resume.tex` (also baked into the image) uses `article` with `geometry`,
`hyperref`, `enumitem`, `titlesec`, `xcolor` and `tabularx`. Other packages (moderncv,
fontawesome5, …) work too; their first use downloads them.

## Overleaf templates and pdfLaTeX font packages

Tectonic is XeTeX; Overleaf defaults to pdfLaTeX. Font packages such as `charter`, `times`,
`palatino` or `helvet` only work in pdfLaTeX's T1 encoding — under XeTeX they silently fall
back to Latin Modern regular, losing all bold and italics (common in RenderCV/Jake's-style
resume templates). `src/lib/latex-fonts.ts` handles this without touching the document:

- **Plain-ASCII source:** T1 is loaded first, so the package uses the same Type 1 fonts as
  Overleaf and line breaks match exactly.
- **Source with typed Unicode** (`–`, `é`, `€`): the OpenType equivalent is swapped in
  (XCharter, TeX Gyre Termes/Pagella/Heros/…) so no character goes missing.

Documents that use `fontspec` or none of these packages compile exactly as written.
`latex/font-warmup.tex` bakes those OpenType fonts into the Lambda image's package cache.
