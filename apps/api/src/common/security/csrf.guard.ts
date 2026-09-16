import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./cookies";
import { AuthenticatedRequest } from "./request-context";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Double-submit CSRF protection: GET /auth/csrf issues a random token in a
 * readable cookie; every state-changing request must echo that value in
 * the x-csrf-token header. A cross-site form post cannot read the cookie
 * to set the header, so the two can only match for same-site JS callers.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    const cookieToken = request.cookies?.[CSRF_COOKIE_NAME];
    const headerToken = request.headers[CSRF_HEADER_NAME];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenException("Missing or invalid CSRF token");
    }

    return true;
  }
}
