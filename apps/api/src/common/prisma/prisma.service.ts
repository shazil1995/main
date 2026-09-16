import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@signage-crm/db";

/**
 * The single untenanted Prisma client. Only auth (looking up a user by
 * email before a tenant is known) and system/admin jobs may query through
 * this service directly. Everything else must go through
 * TenantPrismaService so tenant isolation is enforced by construction.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
