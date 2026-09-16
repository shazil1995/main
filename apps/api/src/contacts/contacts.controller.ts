import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { CreateContactDto } from "./dto/create-contact.dto";
import { SessionAuthGuard } from "../auth/guards/session-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { AuthenticatedRequest, AuthenticatedUser } from "../common/security/request-context";

@Controller("contacts")
@UseGuards(SessionAuthGuard, PermissionsGuard)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  @RequirePermissions("contacts:read")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.list(user);
  }

  @Get(":id")
  @RequirePermissions("contacts:read")
  getById(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contactsService.getById(id, user);
  }

  @Post()
  @RequirePermissions("contacts:write")
  create(@Body() dto: CreateContactDto, @CurrentUser() user: AuthenticatedUser, @Req() req: AuthenticatedRequest) {
    return this.contactsService.create(dto, user, req.ip ?? null);
  }
}
