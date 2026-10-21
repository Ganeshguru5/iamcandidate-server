# DynamoDB design

One table (`personal-os-<stage>`), on-demand billing, no GSIs.

## Why a single table with no GSIs

The frontend was the source for the access patterns. Every screen loads **one user's
complete list** of an entity type (the board, the tables, the command palette and the
detail pages all filter and join in memory), and the only ordered read is the activity
feed. There are no cross-user queries, no lookups by anything other than id, and the
per-user data set is small (hundreds to a few thousand items).

So the user is the partition key, the entity type and id form the sort key, and every
access pattern becomes a `GetItem` or a single-partition `Query`. A GSI would add write cost
and consistency lag without serving any query the frontend makes.

## Keys

| Attribute    | Value                                                 |
| ------------ | ----------------------------------------------------- |
| `PK`         | `USER#<userId>`                                       |
| `SK`         | `<TYPE>#<id>` (see below)                             |
| `entityType` | `APPLICATION`, `COMPANY`, … (for debugging / exports) |
| `userId`     | owner (kept on every item)                            |
| `ttl`        | epoch seconds, only on expiring items                 |

All other attributes are the entity's own fields, stored as top-level attributes
(nested lists/maps for timelines, resume sections, `related`, …).

| Entity                   | SK                                   | Notes                                                                  |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------- |
| Application              | `APPLICATION#<id>`                   | `timeline` stored inline (bounded, always read with the application)   |
| Company                  | `COMPANY#<id>`                       |                                                                        |
| Contact                  | `CONTACT#<id>`                       | `companyId` reference                                                  |
| Referral                 | `REFERRAL#<id>`                      | `contactId`, `companyId` references                                    |
| Interview                | `INTERVIEW#<id>`                     | `applicationId` reference                                              |
| Resume                   | `RESUME#<id>`                        | structured content; optional `documentId` → uploaded file              |
| Document                 | `DOCUMENT#<id>`                      | metadata + private `s3Key` (never returned by the API)                 |
| Project                  | `PROJECT#<id>`                       |                                                                        |
| Task                     | `TASK#<id>`                          | optional `related: { type, id, label }`                                |
| Note                     | `NOTE#<id>`                          |                                                                        |
| Skill                    | `SKILL#<id>`                         |                                                                        |
| Certification            | `CERTIFICATION#<id>`                 | optional `documentId`                                                  |
| Link (bookmark)          | `LINK#<id>`                          |                                                                        |
| Activity                 | `ACTIVITY#<isoDate>#<id>`            | ISO dates sort lexicographically → feed order; `ttl` = date + 365 days |
| Profile                  | `SETTINGS#PROFILE`                   | singleton                                                              |
| Notification preferences | `SETTINGS#NOTIFICATIONS`             | singleton                                                              |
| Notification read marker | `NOTIFICATION_READ#<notificationId>` | `ttl` = 60 days                                                        |

Ids keep the frontend's shape: `<prefix>_<16 hex>` (`app_…`, `cmp_…`, `doc_…`).

### Accounts

Login accounts are the one exception to "partition = user": admins need to list them, so
they live in a registry partition.

| PK      | SK                         | Item                                                                    |
| ------- | -------------------------- | ----------------------------------------------------------------------- |
| `USERS` | `USER#<userId>`            | account: email, name, role, disabled, scrypt `passwordHash`, timestamps |
| `USERS` | `EMAIL#<lowercased email>` | `{ userId }` — login lookup; a conditional put keeps emails unique      |

Deleting a user removes both items, every item in `USER#<userId>` and the user's S3 objects.

## Access patterns

| #   | Pattern                                    | Operation                                                                                                                     |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | List a user's applications / companies / … | `Query PK = USER#u AND begins_with(SK, "APPLICATION#")` (paginated until done)                                                |
| 2   | Get one entity                             | `GetItem PK, SK = <TYPE>#<id>`                                                                                                |
| 3   | Create                                     | `PutItem` with `attribute_not_exists(PK)` → 409 on id clash                                                                   |
| 4   | Update (partial)                           | `GetItem` → merge → `PutItem` with `attribute_exists(PK)` → 404 if deleted meanwhile                                          |
| 5   | Delete                                     | `DeleteItem` with `ReturnValues: ALL_OLD` → 404 when nothing was there                                                        |
| 6   | Activity feed, newest first, paginated     | `Query begins_with(SK, "ACTIVITY#")`, `ScanIndexForward: false`, `Limit`, opaque cursor                                       |
| 7   | Dashboard                                  | 4 list queries (applications, interviews, tasks, documents) + 1 feed page, in parallel                                        |
| 8   | Notifications                              | lists of interviews, applications, tasks, companies + settings + read markers, in parallel; reminders are derived, not stored |
| 9   | Set default resume                         | list resumes → `BatchWriteItem` the changed ones                                                                              |
| 10  | Seed / reset (scripts)                     | `BatchWriteItem` in chunks of 25 with retry of unprocessed items                                                              |

Query-string filters (`?status=offer`, `?companyId=…`) are applied after the partition
query. They read the same items a `FilterExpression` would, so there is no cost difference
at this scale.

## Relationships

```
Company 1─* Application 1─* Interview
   │             │
   │             └─ resumeId → Resume ── documentId → Document (S3 object)
   ├─* Contact ─────── recruiterId (from Application)
   └─* Referral *─1 Contact
Task.related → Application | Project | Contact | Company
Certification.documentId → Document
```

References are plain id attributes resolved by the client from its cached lists (as the
mock backend did). Deletes do not cascade — the frontend already renders missing
references as "Unknown company" and similar.

## Side effects

Writes that the frontend shows elsewhere are done in the service layer:

- **Activity items** for application created / status changed / deleted, company and
  contact added, referral requested, interview scheduled, resume updated, document
  uploaded / deleted, task created / completed, note and project created, profile updated.
  Activity writes are best-effort: a failure is logged but never fails the user's change.
- **Application timeline** events on create, status change, follow-up scheduling and
  interview scheduling.

## Growth path

- **Per-user IAM:** the user id from the session token could also drive IAM's
  `dynamodb:LeadingKeys` condition (via Cognito identity pools) for defence in depth.
- **Large partitions:** if a single user ever outgrows in-memory filtering, add a sparse GSI
  for the specific pattern (e.g. `GSI1PK = USER#u#STATUS#offer`).
- **Single-item updates:** the read-merge-put update could become an `UpdateItem` with a
  version attribute for optimistic locking if concurrent editors are introduced.
