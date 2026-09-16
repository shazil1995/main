import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SESSION_COOKIE_NAME } from "../../common/security/cookies";
import { AuthenticatedRequest } from "../../common/security/request-context";
import { hashToken } from "../../common/security/token.util";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken) {
      throw new UnauthorizedException("Not authenticated");
    }

    const tokenHash = hashToken(rawToken);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
            },
          },
        },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() < Date.now() ||
      !session.user ||
      session.user.status !== "ACTIVE" ||
      session.user.deletedAt
    ) {
      throw new UnauthorizedException("Session expired or invalid");
    }

    const roles = session.user.userRoles.map((ur) => ur.role.name);
    const permissions = new Set<string>();
    for (const userRole of session.user.userRoles) {
      for (const rolePermission of userRole.role.rolePermissions) {
        permissions.add(rolePermission.permission.key);
      }
    }

    request.user = {
      id: session.user.id,
      tenantId: session.user.tenantId,
      email: session.user.email,
      firstName: session.user.firstName,
      lastName: session.user.lastName,
      roles,
      permissions: Array.from(permissions),
    };
    request.tenantId = session.user.tenantId;
    request.sessionId = session.id;

    return true;
  }
}
