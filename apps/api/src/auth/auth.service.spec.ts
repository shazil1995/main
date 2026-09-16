import * as bcrypt from "bcryptjs";
import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { LoginRateLimiter } from "./login-rate-limiter";

describe("AuthService", () => {
  const tenantId = "tenant-1";
  const activeUser = {
    id: "user-1",
    tenantId,
    email: "agent@brightsigns.pk",
    normalizedEmail: "agent@brightsigns.pk",
    passwordHash: "",
    firstName: "Hamza",
    lastName: "Farooq",
    status: "ACTIVE" as const,
    deletedAt: null as Date | null,
    userRoles: [{ role: { name: "sales_agent" } }],
  };

  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    session: { create: jest.Mock };
  };
  let audit: { log: jest.Mock };
  let authService: AuthService;

  beforeAll(async () => {
    activeUser.passwordHash = await bcrypt.hash("Passw0rd!123", 4);
  });

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      session: { create: jest.fn() },
    };
    audit = { log: jest.fn() };
    authService = new AuthService(prisma as any, audit as any, new LoginRateLimiter());
  });

  it("logs in with correct credentials and creates a session", async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.session.create.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});

    const result = await authService.login("agent@brightsigns.pk", "Passw0rd!123", "127.0.0.1");

    expect(result.user.id).toBe("user-1");
    expect(result.user.roles).toEqual(["sales_agent"]);
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.login" }));
  });

  it("rejects an incorrect password without creating a session", async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser);

    await expect(authService.login("agent@brightsigns.pk", "wrong-password", "127.0.0.1")).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("rejects a disabled user even with the correct password", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, status: "DISABLED" });

    await expect(authService.login("agent@brightsigns.pk", "Passw0rd!123", "127.0.0.1")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("rejects an unknown email without revealing whether the account exists", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(authService.login("nobody@brightsigns.pk", "whatever1", "127.0.0.1")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("locks out further attempts after repeated failures from the same key", async () => {
    prisma.user.findUnique.mockResolvedValue(activeUser);

    for (let i = 0; i < 10; i += 1) {
      await expect(authService.login("agent@brightsigns.pk", "wrong-password", "127.0.0.1")).rejects.toThrow();
    }

    await expect(authService.login("agent@brightsigns.pk", "Passw0rd!123", "127.0.0.1")).rejects.toThrow(
      "Too many login attempts. Try again later.",
    );
  });
});
