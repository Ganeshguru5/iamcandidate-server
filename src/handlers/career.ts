import { created, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import {
  applicationInput,
  applicationPatch,
  applicationQuery,
  applicationStatusBody,
  companyInput,
  companyPatch,
  companyQuery,
  contactInput,
  contactPatch,
  contactQuery,
  interviewInput,
  interviewPatch,
  interviewQuery,
  referralInput,
  referralPatch,
  referralQuery,
  timelineEventInput,
} from "../schemas/career"
import { applicationsService } from "../services/applications.service"
import { companiesService } from "../services/companies.service"
import { contactsService } from "../services/contacts.service"
import { filterItems } from "../services/crud"
import { interviewsService } from "../services/interviews.service"
import { referralsService } from "../services/referrals.service"
import { crudRoutes, pathId } from "./crud"

/** Adds equality filtering from the query string to a plain CRUD service. */
function filtered<S extends { list(userId: string): Promise<T[]> }, T>(service: S) {
  return {
    ...service,
    list: async (userId: string, filters: Partial<Record<keyof T, unknown>>) =>
      filterItems(await service.list(userId), filters),
  }
}

export const applicationRoutes: Routes = {
  ...crudRoutes("/applications", applicationsService, {
    input: applicationInput,
    patch: applicationPatch,
    query: applicationQuery,
  }),
  "PUT /applications/{id}/status": async (ctx) => {
    const { status } = validate(applicationStatusBody, ctx.body, "request body")
    return ok(await applicationsService.changeStatus(ctx.userId, pathId(ctx), status))
  },
  "POST /applications/{id}/timeline": async (ctx) => {
    const event = validate(timelineEventInput, ctx.body, "request body")
    return created(await applicationsService.addTimelineEvent(ctx.userId, pathId(ctx), event))
  },
}

export const companyRoutes = crudRoutes("/companies", filtered(companiesService), {
  input: companyInput,
  patch: companyPatch,
  query: companyQuery,
})

export const contactRoutes = crudRoutes("/contacts", filtered(contactsService), {
  input: contactInput,
  patch: contactPatch,
  query: contactQuery,
})

export const referralRoutes = crudRoutes("/referrals", filtered(referralsService), {
  input: referralInput,
  patch: referralPatch,
  query: referralQuery,
})

export const interviewRoutes = crudRoutes("/interviews", filtered(interviewsService), {
  input: interviewInput,
  patch: interviewPatch,
  query: interviewQuery,
})
