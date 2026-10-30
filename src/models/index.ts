/**
 * API models. These mirror `iamcandidate-ui/src/lib/types` — the frontend is the source
 * of truth for the contract. Input shapes live next to their Zod schemas in
 * `src/schemas`.
 */
export type ID = string
/** ISO-8601 date-time string */
export type ISODate = string

export interface Entity {
  id: ID
}

/* ------------------------------------------------------------------ */
/* Career                                                              */
/* ------------------------------------------------------------------ */

export const APPLICATION_STATUSES = [
  "wishlist",
  "applied",
  "recruiter",
  "technical",
  "hr",
  "offer",
  "rejected",
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export const WORK_MODES = ["remote", "hybrid", "onsite"] as const
export const PRIORITIES = ["low", "medium", "high"] as const
export const TIMELINE_EVENT_TYPES = [
  "created",
  "status",
  "email",
  "interview",
  "note",
  "followup",
] as const

export interface TimelineEvent {
  id: ID
  date: ISODate
  title: string
  description?: string
  type: (typeof TIMELINE_EVENT_TYPES)[number]
}

export interface Application extends Entity {
  companyId: ID
  role: string
  location: string
  workMode: (typeof WORK_MODES)[number]
  salary?: string
  status: ApplicationStatus
  priority: (typeof PRIORITIES)[number]
  appliedDate?: ISODate
  nextFollowUp?: ISODate
  jobUrl?: string
  jobId?: string
  source?: string
  description?: string
  recruiterId?: ID
  resumeId?: ID
  notes: string
  timeline: TimelineEvent[]
  createdAt: ISODate
  updatedAt: ISODate
}

export const COMPANY_STATUSES = ["researching", "target", "active", "paused", "closed"] as const

export interface Company extends Entity {
  name: string
  industry: string
  website: string
  location: string
  size: string
  status: (typeof COMPANY_STATUSES)[number]
  description: string
  notes: string
  createdAt: ISODate
}

export const RELATIONSHIPS = [
  "recruiter",
  "hiring_manager",
  "employee",
  "referral",
  "friend",
  "professional",
] as const

export interface Contact extends Entity {
  name: string
  role: string
  companyId?: ID
  email: string
  phone?: string
  linkedin?: string
  relationship: (typeof RELATIONSHIPS)[number]
  lastContacted?: ISODate
  nextFollowUp?: ISODate
  notes: string
  createdAt: ISODate
}

export const REFERRAL_STATUSES = [
  "not_contacted",
  "request_sent",
  "accepted",
  "declined",
  "submitted",
  "no_response",
] as const

export interface Referral extends Entity {
  contactId: ID
  companyId: ID
  role: string
  jobId: string
  jobUrl: string
  requestDate?: ISODate
  followUpDate?: ISODate
  status: (typeof REFERRAL_STATUSES)[number]
  notes: string
  createdAt: ISODate
}

export const INTERVIEW_TYPES = [
  "recruiter_screen",
  "technical",
  "system_design",
  "behavioral",
  "hr",
  "final",
] as const
export type InterviewType = (typeof INTERVIEW_TYPES)[number]
export const INTERVIEW_STATUSES = ["scheduled", "completed", "cancelled"] as const

export interface Interview extends Entity {
  applicationId: ID
  type: InterviewType
  scheduledAt: ISODate
  durationMinutes: number
  interviewers: string[]
  meetingUrl?: string
  status: (typeof INTERVIEW_STATUSES)[number]
  notes: string
  createdAt: ISODate
}

export interface ResumeExperience {
  id: ID
  company: string
  title: string
  period: string
  highlights: string[]
}

export interface ResumeEducation {
  id: ID
  school: string
  degree: string
  period: string
}

export interface Resume extends Entity {
  title: string
  targetRole: string
  version: string
  isDefault: boolean
  summary: string
  skills: string[]
  experience: ResumeExperience[]
  education: ResumeEducation[]
  /** "structured" (form editor, the default) or "latex" (source + compiled PDF). */
  format?: "structured" | "latex"
  /** LaTeX source when `format` is "latex". */
  latexSource?: string
  /** The uploaded file (a Document stored in S3), if any — for LaTeX, the saved PDF. */
  documentId?: ID
  updatedAt: ISODate
  createdAt: ISODate
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const DOCUMENT_CATEGORIES = [
  "resume",
  "certificates",
  "experience",
  "personal",
  "projects",
  "other",
] as const
export const FILE_KINDS = ["pdf", "docx", "image", "sheet", "zip", "text"] as const

export interface DocumentFile extends Entity {
  name: string
  category: (typeof DOCUMENT_CATEGORIES)[number]
  kind: (typeof FILE_KINDS)[number]
  sizeBytes: number
  starred: boolean
  source: "local" | "drive"
  description?: string
  mimeType?: string
  /** Set when imported from Google Drive. */
  driveFileId?: string
  uploadedAt: ISODate
  updatedAt: ISODate
}

/** Stored document item: API fields plus the private S3 object key. */
export interface StoredDocument extends DocumentFile {
  s3Key?: string
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

export const PROJECT_STATUSES = [
  "idea",
  "planning",
  "development",
  "completed",
  "archived",
] as const

export interface Project extends Entity {
  name: string
  description: string
  status: (typeof PROJECT_STATUSES)[number]
  progress: number
  technologies: string[]
  repository?: string
  deployment?: string
  startedAt: ISODate
  updatedAt: ISODate
}

export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const
export const TASK_STATUSES = ["todo", "in_progress", "done"] as const
export const RELATED_TYPES = ["application", "project", "contact", "company"] as const

export interface RelatedItem {
  type: (typeof RELATED_TYPES)[number]
  id: ID
  label: string
}

export interface Task extends Entity {
  title: string
  description: string
  priority: (typeof TASK_PRIORITIES)[number]
  status: (typeof TASK_STATUSES)[number]
  dueDate?: ISODate
  related?: RelatedItem
  completedAt?: ISODate
  createdAt: ISODate
}

export const NOTE_CATEGORIES = [
  "dsa",
  "system_design",
  "react",
  "nextjs",
  "nodejs",
  "ai",
  "career",
  "projects",
  "personal",
] as const

export interface Note extends Entity {
  title: string
  content: string
  category: (typeof NOTE_CATEGORIES)[number]
  tags: string[]
  favorite: boolean
  createdAt: ISODate
  updatedAt: ISODate
}

/** The sync board: one free-form pad per user, the same text on every system. */
export interface Board {
  content: string
  /** `null` until the first save. */
  updatedAt: ISODate | null
}

/** Stored form: the text is AES-256-GCM encrypted at rest. */
export interface StoredBoard {
  encryptedContent: string
  updatedAt: ISODate
}

/* ------------------------------------------------------------------ */
/* Knowledge                                                           */
/* ------------------------------------------------------------------ */

export const SKILL_GROUPS = [
  "frontend",
  "backend",
  "mobile",
  "database",
  "cloud",
  "ai",
  "tools",
] as const

export interface Skill extends Entity {
  name: string
  group: (typeof SKILL_GROUPS)[number]
  /** 0–100 */
  proficiency: number
  years: number
}

export interface Certification extends Entity {
  name: string
  issuer: string
  issueDate: ISODate
  expiryDate?: ISODate
  credentialId: string
  credentialUrl: string
  documentId?: ID
  skills: string[]
}

export const LINK_CATEGORIES = [
  "jobs",
  "learning",
  "tools",
  "documentation",
  "career",
  "projects",
  "resources",
] as const

/** A saved link ("Bookmark" in the frontend). */
export interface Bookmark extends Entity {
  title: string
  url: string
  description: string
  tags: string[]
  category: (typeof LINK_CATEGORIES)[number]
  favorite: boolean
  createdAt: ISODate
}

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export type ActivityType =
  | "application_created"
  | "application_status_changed"
  | "application_deleted"
  | "email_sent"
  | "resume_updated"
  | "document_uploaded"
  | "document_deleted"
  | "task_created"
  | "task_completed"
  | "referral_requested"
  | "interview_scheduled"
  | "note_created"
  | "contact_added"
  | "company_added"
  | "project_updated"
  | "integration_connected"
  | "integration_disconnected"
  | "integration_synced"
  | "data_imported"
  | "drive_synced"
  | "settings_updated"

export type EntityType =
  | "application"
  | "company"
  | "contact"
  | "referral"
  | "interview"
  | "resume"
  | "document"
  | "email"
  | "template"
  | "project"
  | "task"
  | "note"
  | "integration"

export interface Activity extends Entity {
  type: ActivityType
  title: string
  description?: string
  date: ISODate
  entity?: { type: EntityType; id: ID }
}

export type NewActivity = Omit<Activity, "id" | "date">

export interface UserProfile {
  name: string
  email: string
  role: string
  bio: string
  location: string
  avatarUrl?: string
}

export interface NotificationPreferences {
  emailNotifications: boolean
  interviewReminders: boolean
  taskReminders: boolean
  followUpReminders: boolean
  weeklyDigest: boolean
}

export type NotificationKind = "interview" | "follow_up" | "task"

/** A reminder derived from interviews, follow-ups and tasks. */
export interface AppNotification {
  /** Stable id derived from the source entity, e.g. `int-int_123`. */
  id: string
  kind: NotificationKind
  title: string
  subtitle?: string
  /** When the interview / follow-up / task is due. */
  date: ISODate
  href: string
  urgent: boolean
  read: boolean
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export const USER_ROLES = ["admin", "user"] as const
export type UserRole = (typeof USER_ROLES)[number]

/** A login account. The password hash never leaves the backend. */
export interface UserAccount {
  id: ID
  email: string
  name: string
  role: UserRole
  disabled: boolean
  /** Can read everything but change nothing (the public demo account). */
  readOnly?: boolean
  lastLoginAt?: ISODate
  createdAt: ISODate
  updatedAt: ISODate
}

export interface StoredAccount extends UserAccount {
  passwordHash: string
}

/** Someone asking for an account. It becomes a login only when an admin grants it. */
export interface AccessRequest {
  id: ID
  email: string
  name: string
  message?: string
  createdAt: ISODate
}

export interface StoredAccessRequest extends AccessRequest {
  passwordHash: string
}

/* ------------------------------------------------------------------ */
/* Communication                                                       */
/* ------------------------------------------------------------------ */

/** Mail is only sent (and drafted) here; there is no inbox sync yet. */
export const EMAIL_FOLDERS = ["inbox", "sent", "drafts"] as const

export interface EmailAddress {
  name: string
  email: string
}

export interface Email extends Entity {
  folder: (typeof EMAIL_FOLDERS)[number]
  from: EmailAddress
  to: string[]
  cc: string[]
  subject: string
  body: string
  date: ISODate
  read: boolean
  starred: boolean
  applicationId?: ID
  contactId?: ID
  templateId?: ID
  /** Message-ID returned by the SMTP server for sent mail. */
  messageId?: string
}

export const TEMPLATE_CATEGORIES = [
  "referral",
  "outreach",
  "follow_up",
  "interview",
  "other",
] as const

/** Where a template is used: emails (sent from iamcandidate) or LinkedIn messages (copied). */
export const TEMPLATE_CHANNELS = ["email", "linkedin"] as const
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number]

export interface EmailTemplate extends Entity {
  name: string
  category: (typeof TEMPLATE_CATEGORIES)[number]
  /** Missing on templates created before channels existed: treat as "email". */
  channel?: TemplateChannel
  /** Empty for LinkedIn templates. */
  subject: string
  body: string
  usageCount: number
  createdAt: ISODate
  updatedAt: ISODate
}

export const SMTP_ENCRYPTIONS = ["tls", "ssl", "none"] as const

/** SMTP settings as the API returns them: the password itself never leaves the server. */
export interface SmtpSettings {
  host: string
  port: number
  username: string
  /** Always "" in responses. */
  password: string
  hasPassword: boolean
  encryption: (typeof SMTP_ENCRYPTIONS)[number]
  senderName: string
  senderEmail: string
  lastTestedAt?: ISODate
}

/** Stored form: the password is AES-256-GCM encrypted. */
export interface StoredSmtpSettings extends Omit<SmtpSettings, "password" | "hasPassword"> {
  encryptedPassword?: string
}

/* ------------------------------------------------------------------ */
/* Google Drive                                                        */
/* ------------------------------------------------------------------ */

/** One entry of a Drive folder listing (same shape as the frontend's DriveItem). */
export interface DriveItem extends Entity {
  name: string
  type: "folder" | "file"
  /** null for items directly in "My Drive". */
  parentId: ID | null
  kind?: (typeof FILE_KINDS)[number]
  sizeBytes?: number
  modifiedAt: ISODate
  /** Google's MIME type, e.g. application/pdf or application/vnd.google-apps.document. */
  mimeType?: string
}

export interface GoogleDriveStatus {
  connected: boolean
  /** Server has Google OAuth credentials configured. */
  available: boolean
  account?: string
  connectedAt?: ISODate
}

/** Stored per user; tokens are AES-256-GCM encrypted. */
export interface StoredGoogleDrive {
  email: string
  encryptedRefreshToken: string
  encryptedAccessToken?: string
  accessTokenExpiresAt?: number
  scope: string
  connectedAt: ISODate
}

/* ------------------------------------------------------------------ */
/* Google Calendar                                                     */
/* ------------------------------------------------------------------ */

export interface CalendarSyncSummary {
  /** Events created or updated. */
  synced: number
  /** Events removed because their item was cancelled, completed or deleted. */
  removed: number
  interviews: number
  followUps: number
  tasks: number
}

export interface GoogleCalendarStatus {
  connected: boolean
  available: boolean
  account?: string
  connectedAt?: ISODate
  lastSyncedAt?: ISODate
  lastSync?: CalendarSyncSummary
}

/** Same token storage as Drive, plus the ids of the events iamcandidate created. */
export interface StoredGoogleCalendar extends StoredGoogleDrive {
  syncedEventIds: string[]
  lastSyncedAt?: ISODate
  lastSync?: CalendarSyncSummary
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

export interface GitHubStatus {
  connected: boolean
  /** GitHub username. */
  account?: string
  name?: string
  avatarUrl?: string
  connectedAt?: ISODate
}

export interface StoredGitHub {
  login: string
  name?: string
  avatarUrl?: string
  encryptedToken: string
  connectedAt: ISODate
}

export interface GitHubRepo {
  /** "owner/name" */
  fullName: string
  name: string
  description: string
  url: string
  homepage?: string
  private: boolean
  fork: boolean
  archived: boolean
  language?: string
  topics: string[]
  stars: number
  defaultBranch: string
  pushedAt?: ISODate
  /** Id of the iamcandidate project whose repository is this repo, if any. */
  projectId?: ID
}

export interface GitHubCommit {
  sha: string
  message: string
  author: string
  date: ISODate
  url: string
}

export interface GitHubPullRequest {
  number: number
  title: string
  state: "open" | "closed" | "merged"
  author: string
  updatedAt: ISODate
  url: string
}

export interface GitHubActivity {
  repo: GitHubRepo
  commits: GitHubCommit[]
  pullRequests: GitHubPullRequest[]
}

/* ------------------------------------------------------------------ */
/* LinkedIn (data export import)                                       */
/* ------------------------------------------------------------------ */

export const LINKEDIN_EXPORT_KINDS = ["connections", "saved_jobs", "job_applications"] as const
export type LinkedInExportKind = (typeof LINKEDIN_EXPORT_KINDS)[number]

export interface LinkedInImportResult {
  kind: LinkedInExportKind
  /** Rows read from the file. */
  rows: number
  /** New contacts or applications (would be) created. */
  created: number
  /** Rows matching something already in iamcandidate. */
  skipped: number
  /** Rows without the required columns. */
  invalid: number
  companiesCreated: number
  /** Up to 5 example rows, for the preview. */
  sample: string[]
  dryRun: boolean
}

export interface LinkedInStatus {
  lastImportAt?: ISODate
  imports: Partial<Record<LinkedInExportKind, { at: ISODate; created: number }>>
}

/* ------------------------------------------------------------------ */
/* AWS S3 backup                                                       */
/* ------------------------------------------------------------------ */

export interface BackupSummary {
  at: ISODate
  /** Key of the JSON data export in the user's bucket. */
  dataKey: string
  documents: number
  bytes: number
  failed: number
}

export interface AwsBackupStatus {
  connected: boolean
  bucket?: string
  region?: string
  prefix?: string
  accessKeyId?: string
  connectedAt?: ISODate
  lastBackup?: BackupSummary
}

export interface StoredAwsBackup {
  bucket: string
  region: string
  /** "" or a folder ending in "/". */
  prefix: string
  accessKeyId: string
  encryptedSecretAccessKey: string
  connectedAt: ISODate
  lastBackup?: BackupSummary
}

/** One step of a backup; the client calls again with `cursor` until `done`. */
export interface BackupProgress {
  done: boolean
  cursor?: string
  /** Documents copied so far / total. */
  copied: number
  total: number
  bytes: number
  failed: number
  dataKey: string
  summary?: BackupSummary
}

/** Connection state of every server-side integration (one request for the Integrations page). */
export interface IntegrationsOverview {
  googleDrive: GoogleDriveStatus
  googleCalendar: GoogleCalendarStatus
  github: GitHubStatus
  linkedin: LinkedInStatus
  aws: AwsBackupStatus
}

/* ------------------------------------------------------------------ */
/* Pricing (public page, edited by admins)                             */
/* ------------------------------------------------------------------ */

export const PRICING_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const
export type PricingCurrency = (typeof PRICING_CURRENCIES)[number]

export interface PricingPlan {
  id: ID
  name: string
  tagline: string
  /** Price per month when billed monthly; 0 = free. */
  monthlyPrice: number
  /** Price per month when billed yearly (shown with the yearly toggle). */
  yearlyPrice: number
  features: string[]
  ctaLabel: string
  /** Where the button goes: a path like /login, a URL, or mailto:. */
  ctaHref: string
  /** Shown as "Most popular" and emphasized. */
  highlighted: boolean
  /** Hidden plans stay saved but don't appear on the public page. */
  visible: boolean
}

export interface PricingConfig {
  currency: PricingCurrency
  /** Small print under the plans, e.g. taxes or trial terms. */
  note: string
  plans: PricingPlan[]
  updatedAt?: ISODate
}
