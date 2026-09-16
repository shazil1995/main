import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionsGuard } from "./permissions.guard";

function makeContext(permissions: string[]): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { permissions } }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe("PermissionsGuard", () => {
  it("allows the request when no permissions are required", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(guard.canActivate(makeContext([]))).toBe(true);
  });

  it("allows the request when the user holds every required permission", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(["contacts:read", "contacts:write"]),
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(guard.canActivate(makeContext(["contacts:read", "contacts:write", "deals:read"]))).toBe(true);
  });

  it("rejects the request when a required permission is missing", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(["contacts:write"]),
    } as unknown as Reflector;
    const guard = new PermissionsGuard(reflector);
    expect(() => guard.canActivate(makeContext(["contacts:read"]))).toThrow(ForbiddenException);
  });
});
