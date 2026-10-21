import type { APIGatewayProxyEventV2 } from "aws-lambda"

import { authenticate } from "../lib/auth"

/**
 * API Gateway Lambda authorizer (payload 2.0, simple responses) for routes
 * whose functions hold no secrets — currently the LaTeX compiler.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<{ isAuthorized: boolean; context?: Record<string, string> }> {
  try {
    const principal = await authenticate(event)
    return { isAuthorized: true, context: { userId: principal.userId } }
  } catch {
    return { isAuthorized: false }
  }
}
