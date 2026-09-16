import { Module } from "@nestjs/common";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { TenantModule } from "../common/tenant/tenant.module";
import { AuditModule } from "../common/audit/audit.module";

@Module({
  imports: [TenantModule, AuditModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
