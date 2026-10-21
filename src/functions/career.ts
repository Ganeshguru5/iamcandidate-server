import { createHandler } from "../lib/router"
import {
  applicationRoutes,
  companyRoutes,
  contactRoutes,
  interviewRoutes,
  referralRoutes,
} from "../handlers/career"

/** CareerFunction: applications, companies, contacts, referrals, interviews. */
export const handler = createHandler({
  ...applicationRoutes,
  ...companyRoutes,
  ...contactRoutes,
  ...referralRoutes,
  ...interviewRoutes,
})
