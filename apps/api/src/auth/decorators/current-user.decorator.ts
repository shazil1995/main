import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { AuthenticatedRequest, AuthenticatedUser } from "../../common/security/request-context";

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) {
    throw new Error("CurrentUser decorator used outside an authenticated route");
  }
  return request.user;
});
