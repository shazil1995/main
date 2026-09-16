import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { SessionAuthGuard } from "./guards/session-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";
import { AuthenticatedRequest, AuthenticatedUser } from "../common/security/request-context";
import { CSRF_COOKIE_NAME, csrfCookieOptions, SESSION_COOKIE_NAME, sessionCookieOptions } from "../common/security/cookies";
import { generateOpaqueToken } from "../common/security/token.util";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get("csrf")
  issueCsrfToken(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const csrfToken = generateOpaqueToken(16);
    res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions);
    return { csrfToken };
  }

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto.email, dto.password, req.ip ?? null);

    res.cookie(SESSION_COOKIE_NAME, result.token, sessionCookieOptions);
    res.cookie(CSRF_COOKIE_NAME, result.csrfToken, csrfCookieOptions);

    return { user: result.user, csrfToken: result.csrfToken };
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionId && req.user) {
      await this.authService.logout(req.sessionId, req.user.tenantId, req.user.id, req.ip ?? null);
    }
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
    res.clearCookie(CSRF_COOKIE_NAME, csrfCookieOptions);
    return { success: true };
  }

  @Get("me")
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
