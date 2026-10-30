# Local development

There are two ways to run the backend locally:

|              | `npm run dev` (recommended)                                | `sam local` (Docker)                                 |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------- |
| Needs        | Node.js                                                    | Docker Desktop, SAM CLI, `sam build`                 |
| Runs         | One Node process                                           | A Docker container per Lambda, DynamoDB Local, MinIO |
| Database     | dynalite (DynamoDB-compatible), saved in `.local/dynamodb` | DynamoDB Local container                             |
| Files        | Small S3 stand-in, saved in `.local/s3`                    | MinIO                                                |
| Code changes | Auto-restart in about a second                             | Re-run `npm run build` (minutes on Windows)          |
| Use it for   | Day-to-day development                                     | A final check of the real Lambda/API Gateway setup   |

Both run the same route handlers, auth and validation, on `http://localhost:3001`.

## Lightweight: `npm run dev`

```bash
cd iamcandidate-server
npm install
npm run dev
```

The first start creates the table, loads the frontend's demo data and the admin login
`demo@example.com` / `demo123`. Data persists in `.local/` (git-ignored) across restarts.

| Command             |                                                                               |
| ------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`       | Start the API (and its database and file storage); restarts when code changes |
| `npm run dev:reset` | Delete `.local/` — the next start re-seeds from scratch                       |

Ports can be changed with `PORT` (API, 3001), `DEV_DB_PORT` (8010) and `DEV_S3_PORT` (9010).
Browse the data with `DYNAMO_ENDPOINT=http://localhost:8010 npx dynamodb-admin` while it runs.
Stop `sam local` first if it is holding port 3001.

Differences from AWS: requests don't go through API Gateway or Lambda, and the S3 stand-in
doesn't check presigned-URL signatures. Run the `sam local` setup below (or deploy) to test
those parts.

## Testing email locally

Sending uses your own SMTP account (Settings → Email). To test without sending real mail,
run a local mail catcher such as [smtp4dev](https://github.com/rnwood/smtp4dev) or
MailHog and point the settings at it (host `localhost`, its SMTP port, encryption _None_).
Both local setups allow private SMTP hosts (`ALLOW_PRIVATE_SMTP_HOSTS=true`); deployed
stacks don't. With a real account (e.g. Gmail + app password), mail is really delivered.

## Docker: `sam local`

```
Next.js (localhost:3000)
   │  NEXT_PUBLIC_API_MODE=api, NEXT_PUBLIC_API_URL=http://localhost:3001
   ▼
sam local start-api (localhost:3001)
   │  one Docker container per Lambda, on the `iamcandidate-local` network
   ├──► DynamoDB Local   http://dynamodb:8000  (host: localhost:8000)
   └──► MinIO (S3 API)   http://minio:9000     (host: localhost:9000, console :9001)
```

MinIO stands in for S3 so the presigned-upload flow works end to end without an AWS
account. Presigned URLs are signed for `http://localhost:9000` (`S3_PUBLIC_ENDPOINT`) so the
browser can reach them, while Lambda containers talk to `http://minio:9000`.

## Prerequisites

- Node.js 22+
- Docker Desktop (running)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS CLI only for deployment — no AWS account is needed locally

## First run

```bash
# Terminal 1 — infrastructure
cd iamcandidate-server
npm install
cp .env.example .env
npm run local:up          # docker compose: DynamoDB Local + MinIO
npm run local:setup       # create table + bucket (idempotent)
npm run seed              # demo data + admin login demo@example.com / demo123

# Terminal 2 — API
npm run build             # sam build (esbuild bundles each function)
npm run start             # sam local start-api on :3001

# Terminal 3 — frontend
cd ../iamcandidate-ui
cp .env.example .env.local   # then set NEXT_PUBLIC_API_MODE=api
npm run dev
```

After changing backend code, run `npm run build` again; `sam local`
serves the built artifacts in `.aws-sam/`.

### Using a single `docker run` instead of compose

```bash
docker network create iamcandidate-local
docker run -d --name dynamodb --network iamcandidate-local -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -sharedDb
```

Keep `-sharedDb`: without it DynamoDB Local keeps a separate database per access key and
region, and the Lambda containers would not see the table created by `local:setup`.
Without MinIO, document uploads fail locally (everything else works).

## Environment

| Variable                                    | Local value                                                      | AWS                                   |
| ------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `AWS_REGION`                                | `ap-south-1`                                                     | set by Lambda                         |
| `STAGE`                                     | `local`                                                          | stack parameter                       |
| `DYNAMODB_TABLE`                            | `personal-os-local`                                              | from template                         |
| `DYNAMODB_ENDPOINT`                         | `http://localhost:8000` (scripts) / `http://dynamodb:8000` (SAM) | empty → AWS endpoint                  |
| `S3_BUCKET`                                 | `personal-os-documents-local`                                    | from template                         |
| `S3_ENDPOINT`                               | `http://localhost:9000` / `http://minio:9000`                    | empty                                 |
| `S3_PUBLIC_ENDPOINT`                        | `http://localhost:9000`                                          | empty                                 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | MinIO's local-only credentials                                   | empty → Lambda role                   |
| `ALLOWED_ORIGINS`                           | `http://localhost:3000`                                          | stack parameter                       |
| `DEFAULT_USER_ID`                           | `usr_demo`                                                       | unused (open mode fallback for tests) |

`.env` is read by scripts and tests; the Lambda containers get their values from
`template.yaml`, overridden by `env.local.json`. No AWS credentials are needed or stored for
local work — the SDK uses fixed dummy credentials whenever `DYNAMODB_ENDPOINT` is set.

`AUTH_SECRET` (in `env.local.json`) signs session tokens. The committed value is for local use
only; deployments get their own through the `AuthSecret` stack parameter.

## Signing in

`npm run seed` creates the admin `demo@example.com` / `demo123`, which owns the demo data.
Sign in with it, then add more users under **System → Users** (admins only). Each user gets
their own empty workspace. To create an account from the terminal instead:

```bash
npm run create-user -- --email you@example.com --name "Your Name" --role admin
```

## Scripts

| Script                                  |                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run build` / `start`               | `sam build` / `sam local start-api` on port 3001                             |
| `npm run validate`                      | `sam validate --lint`                                                        |
| `npm run local:up` / `local:down`       | Start / stop DynamoDB Local + MinIO                                          |
| `npm run local:setup`                   | Create the table and bucket locally                                          |
| `npm run seed` (`-- --reset`)           | Load the frontend's mock data (optionally wiping the user's partition first) |
| `npm test`                              | Unit tests (in-memory DynamoDB fake, real S3 presigner)                      |
| `RUN_INTEGRATION=1 npm test`            | Also run repository tests against DynamoDB Local                             |
| `npm run typecheck` / `lint` / `format` |                                                                              |

## Invoking one function

```bash
sam local invoke CareerFunction --event events/list-applications.json \
  --env-vars env.local.json --docker-network iamcandidate-local
```

## Troubleshooting

| Symptom                                                                | Fix                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Frontend toast "Can't reach the API at http://localhost:3001"          | `npm run start` isn't running, or `NEXT_PUBLIC_API_URL` is wrong (restart `next dev` after changing env).                   |
| `ResourceNotFoundException` / 500 on every call                        | Table missing — run `npm run local:setup`. If you started DynamoDB Local yourself, add `-sharedDb`.                         |
| `getaddrinfo ENOTFOUND dynamodb`                                       | SAM containers aren't on the compose network: start with `npm run start` (it passes `--docker-network iamcandidate-local`).         |
| CORS error in the browser                                              | The frontend origin must be listed in `ALLOWED_ORIGINS` (env.local.json locally, `AllowedOrigins` parameter in AWS).        |
| Upload fails at the PUT step                                           | MinIO not running, or the bucket is missing (`npm run local:setup`).                                                        |
| "Missing required environment variable DYNAMODB_TABLE" in scripts      | `cp .env.example .env`.                                                                                                     |
| Port 3000 already in use                                               | That's Next.js; the API runs on 3001 on purpose.                                                                            |
| Changes don't show up                                                  | Re-run `npm run build` before `npm run start`.                                                                              |
| `Runtime.ImportModuleError: Cannot find module 'users'` (500 from SAM) | The build didn't finish — `.aws-sam/build/template.yaml` is missing. Run `npm run build` until it prints "Build Succeeded". |
| Every request takes 30–60 s or times out                               | Use `npm run start` (it runs functions as x86_64). Plain `sam local start-api` emulates arm64 on Intel/AMD PCs.             |
| Sign-in spins forever                                                  | The API returned an error or is slow: check the `npm run start` terminal and `docker logs` of the Lambda container.         |
