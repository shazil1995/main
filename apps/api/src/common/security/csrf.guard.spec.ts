import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { CsrfGuard } from "./csrf.guard";

function makeContext(method: string, cookieToken?: string, headerToken?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        cookies: cookieToken ? { csrf: cookieToken } : {},
        headers: headerToken ? { "x-csrf-token": headerToken } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("CsrfGuard", () => {
  const guard = new CsrfGuard();

  it("allows safe methods without a token", () => {
    expect(guard.canActivate(makeContext("GET"))).toBe(true);
  });

  it("allows a mutating request when cookie and header tokens match", () => {
    expect(guard.canActivate(makeContext("POST", "token-abc", "token-abc"))).toBe(true);
  });

  it("rejects a mutating request with mismatched tokens", () => {
    expect(() => guard.canActivate(makeContext("POST", "token-abc", "token-xyz"))).toThrow(ForbiddenException);
  });

  it("rejects a mutating request with no token at all", () => {
    expect(() => guard.canActivate(makeContext("POST"))).toThrow(ForbiddenException);
  });
});
