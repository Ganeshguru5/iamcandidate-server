import { requireAdmin } from "../lib/auth"
import { created, noContent, ok } from "../lib/response"
import type { Routes } from "../lib/router"
import { validate } from "../lib/validation"
import { changePasswordInput, createUserInput, loginInput, updateUserInput } from "../schemas/users"
import { usersService } from "../services/users.service"
import { pathId } from "./crud"

/** The only route that doesn't need a session. */
export const PUBLIC_ROUTES = ["POST /auth/login"]

export const authRoutes: Routes = {
  "POST /auth/login": async (ctx) => {
    const { email, password } = validate(loginInput, ctx.body, "request body")
    return ok(await usersService.login(email, password))
  },
  "POST /auth/refresh": async (ctx) => ok(await usersService.refresh(ctx.userId)),
  "GET /auth/me": async (ctx) => ok(await usersService.me(ctx.userId)),
  "PUT /auth/password": async (ctx) => {
    const body = validate(changePasswordInput, ctx.body, "request body")
    await usersService.changePassword(ctx.userId, body.currentPassword, body.newPassword)
    return noContent()
  },
}

/** Admin-only user management. */
export const userRoutes: Routes = {
  "GET /users": async (ctx) => {
    requireAdmin(ctx)
    return ok(await usersService.list())
  },
  "POST /users": async (ctx) => {
    requireAdmin(ctx)
    return created(await usersService.create(validate(createUserInput, ctx.body, "request body")))
  },
  "GET /users/{id}": async (ctx) => {
    requireAdmin(ctx)
    return ok(await usersService.get(pathId(ctx)))
  },
  "PUT /users/{id}": async (ctx) => {
    requireAdmin(ctx)
    const id = pathId(ctx)
    const patch = validate(updateUserInput, ctx.body, "request body")
    return ok(await usersService.update(ctx.userId, id, patch))
  },
  "DELETE /users/{id}": async (ctx) => {
    requireAdmin(ctx)
    await usersService.remove(ctx.userId, pathId(ctx))
    return noContent()
  },
}
