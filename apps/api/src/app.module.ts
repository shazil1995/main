import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./common/prisma/prisma.module";
import { TenantModule } from "./common/tenant/tenant.module";
import { AuditModule } from "./common/audit/audit.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { CsrfGuard } from "./common/security/csrf.guard";
import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { ContactsModule } from "./contacts/contacts.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TenantModule,
    AuditModule,
    AuthModule,
    HealthModule,
    ContactsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
