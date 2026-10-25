import { createHandler } from "../lib/router"
import { boardRoutes, noteRoutes, projectRoutes, taskRoutes } from "../handlers/workspace"

/** WorkspaceFunction: projects, tasks, notes, sync board. */
export const handler = createHandler({
  ...projectRoutes,
  ...taskRoutes,
  ...noteRoutes,
  ...boardRoutes,
})
