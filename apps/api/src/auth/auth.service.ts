import { Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { normalizeEmail } from "@signage-crm/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditService } from "../common/audit/audit.service";
import { SESSION_TTL_MS } from "../common/security/cookies";
import { generateOpaqueToken, hashToken } from "../common/security/token.util";
import { LoginRateLimiter } from "./login-rate-limiter";

export interface LoginResult {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: {
    id: string;
    tenantId: string;
    email: string;
    firstName: string;
    lastName: string;
    roles: string[];
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  async login(email: string, password: string, ipAddress: string | null): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(email);
    const rateLimitKey = `${normalizedEmail}:${ipAddress ?? "unknown"}`;

    if (this.rateLimiter.isBlocked(rateLimitKey)) {
      throw new UnauthorizedException("Too many login attempts. Try again later.");
    }

    const user = await this.prisma.user.findUnique({
      where: { normalizedEmail },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;

    if (!user || !passwordMatches || user.status !== "ACTIVE" || user.deletedAt) {
      this.rateLimiter.recordAttempt(rateLimitKey);
      if (user) {
        await this.audit.log({
          tenantId: user.tenantId,
          actorUserId: user.id,
          action: "auth.login_failed",
          resourceType: "User",
          resourceId: user.id,
          ipAddress,
        });
      }
      throw new UnauthorizedException("Invalid email or password");
    }

    this.rateLimiter.reset(rateLimitKey);

    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        ipAddress,
        expiresAt,
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "auth.login",
      resourceType: "User",
      resourceId: user.id,
      ipAddress,
    });

    return {
      token: rawToken,
      csrfToken: generateOpaqueToken(16),
      expiresAt,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: user.userRoles.map((ur) => ur.role.name),
      },
    };
  }

  async logout(sessionId: string, tenantId: string, actorUserId: string, ipAddress: string | null): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      action: "auth.logout",
      resourceType: "Session",
      resourceId: sessionId,
      ipAddress,
    });
  }
}
