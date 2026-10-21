import { createHandler } from "../lib/router"
import { noteRoutes, projectRoutes, taskRoutes } from "../handlers/workspace"

/** WorkspaceFunction: projects, tasks, notes. */
export const handler = createHandler({ ...projectRoutes, ...taskRoutes, ...noteRoutes })
