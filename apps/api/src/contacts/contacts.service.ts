import { Injectable, NotFoundException } from "@nestjs/common";
import { normalizeEmail, normalizePhoneToE164 } from "@signage-crm/shared";
import { TenantPrismaFactory } from "../common/tenant/tenant-prisma.factory";
import { AuditService } from "../common/audit/audit.service";
import { CreateContactDto } from "./dto/create-contact.dto";
import { AuthenticatedUser } from "../common/security/request-context";

const contactWithDetails = {
  emails: true,
  phones: true,
  company: true,
} as const;

@Injectable()
export class ContactsService {
  constructor(
    private readonly tenantPrismaFactory: TenantPrismaFactory,
    private readonly audit: AuditService,
  ) {}

  list(actor: AuthenticatedUser) {
    const client = this.tenantPrismaFactory.forTenant(actor.tenantId);
    return client.contact.findMany({
      where: { deletedAt: null },
      include: contactWithDetails,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async getById(id: string, actor: AuthenticatedUser) {
    const client = this.tenantPrismaFactory.forTenant(actor.tenantId);
    const contact = await client.contact.findUnique({
      where: { id },
      include: contactWithDetails,
    });
    if (!contact || contact.deletedAt) {
      throw new NotFoundException("Contact not found");
    }
    return contact;
  }

  async create(dto: CreateContactDto, actor: AuthenticatedUser, ipAddress: string | null) {
    const client = this.tenantPrismaFactory.forTenant(actor.tenantId);
    const contact = await client.contact.create({
      data: {
        tenantId: actor.tenantId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        ownerId: actor.id,
        companyId: dto.companyId,
        emails: dto.email
          ? { create: [{ email: dto.email, normalizedEmail: normalizeEmail(dto.email), isPrimary: true }] }
          : undefined,
        phones: dto.phone
          ? {
              create: [
                {
                  phone: dto.phone,
                  normalizedPhoneE164: normalizePhoneToE164(dto.phone) ?? dto.phone,
                  isPrimary: true,
                },
              ],
            }
          : undefined,
      },
      include: contactWithDetails,
    });

    await this.audit.log({
      tenantId: actor.tenantId,
      actorUserId: actor.id,
      action: "contact.created",
      resourceType: "Contact",
      resourceId: contact.id,
      ipAddress,
    });

    return contact;
  }
}
