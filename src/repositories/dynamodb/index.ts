import type {
  Application,
  Email,
  EmailTemplate,
  Bookmark,
  Certification,
  Company,
  Contact,
  Interview,
  Note,
  Project,
  Referral,
  Resume,
  Skill,
  StoredDocument,
  Task,
} from "../../models"
import { EntityRepository } from "./entity.repository"

export { accessRequestsRepository } from "./access-requests.repository"
export { activityRepository } from "./activity.repository"
export {
  notificationReadRepository,
  SECRET_SETTINGS,
  settingsRepository,
} from "./settings.repository"
export { EntityRepository } from "./entity.repository"
export { normalizeEmail, usersRepository } from "./users.repository"

export const repositories = {
  applications: new EntityRepository<Application>("APPLICATION", "Application"),
  companies: new EntityRepository<Company>("COMPANY", "Company"),
  contacts: new EntityRepository<Contact>("CONTACT", "Contact"),
  referrals: new EntityRepository<Referral>("REFERRAL", "Referral"),
  interviews: new EntityRepository<Interview>("INTERVIEW", "Interview"),
  resumes: new EntityRepository<Resume>("RESUME", "Resume"),
  documents: new EntityRepository<StoredDocument>("DOCUMENT", "Document"),
  projects: new EntityRepository<Project>("PROJECT", "Project"),
  tasks: new EntityRepository<Task>("TASK", "Task"),
  notes: new EntityRepository<Note>("NOTE", "Note"),
  skills: new EntityRepository<Skill>("SKILL", "Skill"),
  certifications: new EntityRepository<Certification>("CERTIFICATION", "Certification"),
  links: new EntityRepository<Bookmark>("LINK", "Link"),
  emails: new EntityRepository<Email>("EMAIL", "Email"),
  templates: new EntityRepository<EmailTemplate>("TEMPLATE", "Template"),
}
