import { Injectable } from "@nestjs/common";
import { forTenant, PrismaClient } from "@signage-crm/db";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Plain singleton factory for tenant-scoped Prisma clients.
 *
 * This is deliberately NOT a Scope.REQUEST provider: NestJS does not
 * reliably invoke a route's guards when its controller becomes
 * request-scoped (verified empirically — see DECISIONS.md), which would
 * silently defeat the tenant guard it's meant to protect. Instead,
 * services call forTenant(tenantId) explicitly with the tenantId taken
 * from the already-authenticated @CurrentUser(), after SessionAuthGuard
 * has run as a normal singleton guard.
 */
@Injectable()
export class TenantPrismaFactory {
  constructor(private readonly prisma: PrismaService) {}

  forTenant(tenantId: string): PrismaClient {
    if (!tenantId) {
      throw new Error("TenantPrismaFactory.forTenant() requires a non-empty tenantId");
    }
    return forTenant(this.prisma, tenantId);
  }
}
