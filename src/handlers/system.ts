import { noContent, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import {
  activityQuery,
  autofillLearnInput,
  autofillProfileInput,
  dashboardQuery,
  notificationIdParam,
  notificationPreferencesInput,
  notificationsQuery,
  profileInput,
} from "../schemas/system"
import { activitiesService } from "../services/activities.service"
import { autofillService } from "../services/autofill.service"
import { dashboardService } from "../services/dashboard.service"
import { notificationsService } from "../services/notifications.service"
import { settingsService } from "../services/settings.service"

export const activityRoutes: Routes = {
  "GET /activities": async (ctx) => {
    const query = validate(activityQuery, ctx.query, "query parameters")
    const page = await activitiesService.list(ctx.userId, {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    })
    return ok(page.items, { nextCursor: page.nextCursor ?? null })
  },
}

export const notificationRoutes: Routes = {
  "GET /notifications": async (ctx) => {
    const { tzOffset } = validate(notificationsQuery, ctx.query, "query parameters")
    return ok(await notificationsService.list(ctx.userId, tzOffset))
  },
  "PUT /notifications/{id}/read": async (ctx) => {
    const { id } = validate(notificationIdParam, ctx.params, "path parameters")
    await notificationsService.markRead(ctx.userId, id)
    return noContent()
  },
  "PUT /notifications/read-all": async (ctx) => {
    const { tzOffset } = validate(notificationsQuery, ctx.query, "query parameters")
    return ok(await notificationsService.markAllRead(ctx.userId, tzOffset))
  },
}

export const settingsRoutes: Routes = {
  "GET /settings/profile": async (ctx) => ok(await settingsService.getProfile(ctx.userId)),
  "PUT /settings/profile": async (ctx) =>
    ok(
      await settingsService.updateProfile(
        ctx.userId,
        validate(profileInput, ctx.body, "request body"),
      ),
    ),
  "GET /settings/autofill": async (ctx) => ok(await autofillService.get(ctx.userId)),
  "PUT /settings/autofill": async (ctx) =>
    ok(
      await autofillService.update(
        ctx.userId,
        validate(autofillProfileInput, ctx.body, "request body"),
      ),
    ),
  "POST /settings/autofill/learn": async (ctx) =>
    ok(
      await autofillService.learn(ctx.userId, validate(autofillLearnInput, ctx.body, "request body")),
    ),
  "GET /settings/notifications": async (ctx) =>
    ok(await settingsService.getNotificationPreferences(ctx.userId)),
  "PUT /settings/notifications": async (ctx) =>
    ok(
      await settingsService.updateNotificationPreferences(
        ctx.userId,
        validate(notificationPreferencesInput, ctx.body, "request body"),
      ),
    ),
}

export const dashboardRoutes: Routes = {
  "GET /dashboard": async (ctx) => {
    const { tzOffset } = validate(dashboardQuery, ctx.query, "query parameters")
    return ok(await dashboardService.getSummary(ctx.userId, tzOffset))
  },
}
