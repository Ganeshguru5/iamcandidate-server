# knot-server — Personal OS backend

Serverless backend for the [Personal OS frontend](../knot/README.md): AWS SAM, API Gateway
HTTP API, Lambda (Node.js 22 + TypeScript), DynamoDB and S3. It implements exactly the data
contract the frontend's service layer (`knot/src/lib/services/contracts.ts`) already uses.

No AI services are included in this phase.

```
                         ┌──────────────────────┐
                         │  Next.js frontend    │  NEXT_PUBLIC_API_MODE=api
                         └──────────┬───────────┘
                                    │ HTTPS / JSON              ┌───────────────┐
                                    ▼                     ┌────►│ S3 (private)  │
                         ┌──────────────────────┐         │     └───────────────┘
                         │ API Gateway HTTP API │         │  browser PUT/GET via
                         └──────────┬───────────┘         │  presigned URLs
     ┌──────────┬───────────┬───────┴────┬───────────┬────┴───────┐
     ▼          ▼           ▼            ▼           ▼            ▼
  Career    Documents   Workspace   Knowledge     System      Dashboard
  Lambda     Lambda      Lambda      Lambda       Lambda       Lambda
     │          │ ──S3──►   │            │           │            │
     └──────────┴───────────┴─────┬──────┴───────────┴────────────┘
                                  ▼
                   DynamoDB — single table, PK = USER#<id>
```

| Function                          | Routes                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `CareerFunction`                  | `/applications`, `/companies`, `/contacts`, `/referrals`, `/interviews`        |
| `DocumentsFunction`               | `/documents` (presigned uploads/downloads), `/resumes`                         |
| `WorkspaceFunction`               | `/projects`, `/tasks`, `/notes`                                                |
| `KnowledgeFunction`               | `/skills`, `/certifications`, `/links`                                         |
| `SystemFunction`                  | `/activities`, `/notifications`, `/settings/*`                                 |
| `DashboardFunction`               | `/dashboard`                                                                   |
| `UsersFunction`                   | `/auth/*` (sign-in, own password), `/users` (admin user management)            |
| `CommunicationFunction`           | `/emails` (send via the user's SMTP, drafts), `/templates`, `/settings/smtp`   |
| `IntegrationsFunction`            | `/integrations/google-drive` (OAuth connect, browse, import into Documents)    |
| `LatexFunction` (container image) | `POST /latex/compile` — Tectonic, isolated, behind `SessionAuthorizerFunction` |

## Quick start (local)

Requires only Node.js 22+ — no Docker, no SAM:

```bash
npm install
npm run dev             # API on http://localhost:3001, restarts on code changes
```

The first start creates a local database (dynalite, saved in `.local/`), loads the demo
data and the admin login `demo@example.com` / `demo123`. File uploads work too. Then in
`../knot`: set `NEXT_PUBLIC_API_MODE=api` in `.env.local` and `npm run dev`.

To check the real Lambda + API Gateway setup before deploying, use the Docker-based
`sam local` workflow described in the guide.
Full guide and troubleshooting: [docs/local-development.md](docs/local-development.md).

## Deploy

```bash
npm run build           # sam build (uses the project's esbuild)
sam deploy --guided     # region ap-south-1
```

See [docs/deployment.md](docs/deployment.md).

## Documentation

- [API reference + curl examples](docs/api.md)
- [DynamoDB design](docs/dynamodb-design.md) — keys, access patterns, relationships
- [Local development](docs/local-development.md) — environment variables, scripts, troubleshooting
- [LaTeX resumes](docs/latex.md) — Tectonic setup, isolation
- [Google Drive setup](docs/google-drive.md) — Google Cloud OAuth client, limits
- [Deployment](docs/deployment.md) — SAM, CORS, security, teardown

## Project layout

```
template.yaml            SAM: HTTP API, 6 functions, table, bucket, IAM, log groups
samconfig.toml           build/deploy defaults (ap-south-1; dev + prod environments)
env.local.json           Lambda env for `sam local` (local endpoints only, no secrets)
docker-compose.yml       DynamoDB Local + MinIO on the `knot-local` network
src/
  functions/             Lambda entry points — one per function, merging route tables
  handlers/              route tables: validate input → call service → standard response
  services/              business rules (timelines, activity feed, S3 checks, dashboard)
  repositories/
    dynamodb/            single-table access (keys, conditional writes, pagination)
    s3/                  presigned URLs, HeadObject, DeleteObject
  schemas/               Zod schemas for bodies, queries and partial updates
  models/                API types (mirror the frontend's `src/lib/types`)
  lib/                   config, clients, router, errors, responses, validation, auth, time
scripts/                 local setup and seed
tests/                   unit tests (+ opt-in DynamoDB Local integration test)
events/                  sample API Gateway events for `sam local invoke`
docs/
```

## Conventions

- **Responses:** `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`.
  Unexpected errors become a generic `500 INTERNAL_ERROR`; the real error is logged as JSON to CloudWatch.
- **Validation:** every path parameter, query string and body goes through Zod (`src/schemas`).
  Unknown fields are rejected; `PUT` is a partial update where `null` clears an optional field.
- **Auth and ownership:** every route except `POST /auth/login` needs `Authorization: Bearer <token>`.
  The token carries only the user id; the account is re-read on each request, so disabling or deleting a
  user takes effect immediately. All data is keyed by that user id, so each user sees only their own data.
  Admins manage users at `/users`. See [docs/api.md](docs/api.md#authentication).
- **Configuration:** endpoints come from the environment (`DYNAMODB_ENDPOINT`, `S3_ENDPOINT`). Empty in
  AWS → real service endpoints. Nothing is hardcoded to localhost and no credentials are stored.

## Checks

```bash
npm run typecheck && npm run lint && npm test
npm run validate        # sam validate --lint
```

## Not in this phase

Receiving email (inbox sync), the GitHub/Calendar/LinkedIn integrations, and all AI
features. The frontend keeps using its mocks for those.
