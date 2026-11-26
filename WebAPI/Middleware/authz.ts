import { AppError } from "@core/errors.js";
import type { UserClaims } from "@core/types.js";
import { ForbiddenError } from "./errors.js";

export function requireUser(request: { user?: UserClaims }): UserClaims {
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user;
}

export { AppError };
