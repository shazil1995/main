import { Injectable } from "@nestjs/common";
import type { Prisma } from "@signage-crm/db";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditLogInput {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Writes immutable audit records. Uses the untenanted PrismaService
 * directly (not TenantPrismaService) because audit writes must succeed
 * even for actions like a failed login where no tenant-scoped request
 * context exists yet; the tenantId is always supplied explicitly by the
 * caller instead of being inferred from request state.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: input.ipAddress ?? null,
      },
    });
  }
}
