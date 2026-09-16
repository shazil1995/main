import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LoginRateLimiter } from "./login-rate-limiter";
import { AuditModule } from "../common/audit/audit.module";

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [AuthService, LoginRateLimiter],
  exports: [AuthService],
})
export class AuthModule {}
