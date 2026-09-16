import { Module } from "@nestjs/common";
import { TenantPrismaFactory } from "./tenant-prisma.factory";

@Module({
  providers: [TenantPrismaFactory],
  exports: [TenantPrismaFactory],
})
export class TenantModule {}
