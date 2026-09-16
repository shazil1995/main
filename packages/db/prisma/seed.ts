import { PrismaClient, LeadSourceType, LeadStatus, LeadPriority, TaskStatus, TaskPriority } from "../generated/client";
import * as bcrypt from "bcryptjs";
import { DEFAULT_ROLES, PERMISSIONS } from "../src/permissions";
import { normalizeEmail, normalizePhoneToE164 } from "@signage-crm/shared";

const prisma = new PrismaClient();

const SEED_PASSWORD = "Passw0rd!123";

async function main() {
  console.log("Seeding Signage CRM development data...");

  const tenant = await prisma.tenant.upsert({
    where: { slug: "bright-signs" },
    update: {},
    create: {
      name: "Bright Signs Co",
      slug: "bright-signs",
      timezone: "Asia/Karachi",
      defaultCurrency: "PKR",
    },
  });

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { description: permission.description },
      create: permission,
    });
  }

  const roleByName = new Map<string, string>();
  for (const [roleName, permissionKeys] of Object.entries(DEFAULT_ROLES)) {
    const role = await prisma.role.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: roleName } },
      update: {},
      create: {
        tenantId: tenant.id,
        name: roleName,
        isSystem: true,
        description: `Default ${roleName.replace(/_/g, " ")} role`,
      },
    });
    roleByName.set(roleName, role.id);

    for (const permissionKey of permissionKeys) {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key: permissionKey },
      });
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  const salesTeam = await prisma.team.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Sales" } },
    update: {},
    create: { tenantId: tenant.id, name: "Sales", description: "Signage sales team" },
  });

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  const seedUsers: Array<{
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  }> = [
    { email: "admin@brightsigns.pk", firstName: "Ayesha", lastName: "Malik", role: "administrator" },
    { email: "manager@brightsigns.pk", firstName: "Bilal", lastName: "Sheikh", role: "sales_manager" },
    { email: "caller@brightsigns.pk", firstName: "Sana", lastName: "Qureshi", role: "calling_agent" },
    { email: "agent@brightsigns.pk", firstName: "Hamza", lastName: "Farooq", role: "sales_agent" },
    { email: "designer@brightsigns.pk", firstName: "Zara", lastName: "Iqbal", role: "designer_or_estimator" },
    { email: "analyst@brightsigns.pk", firstName: "Usman", lastName: "Tariq", role: "read_only_analyst" },
  ];

  const userByEmail = new Map<string, string>();
  for (const seedUser of seedUsers) {
    const normalizedEmail = normalizeEmail(seedUser.email);
    const user = await prisma.user.upsert({
      where: { normalizedEmail },
      update: {},
      create: {
        tenantId: tenant.id,
        email: seedUser.email,
        normalizedEmail,
        passwordHash,
        firstName: seedUser.firstName,
        lastName: seedUser.lastName,
        status: "ACTIVE",
      },
    });
    userByEmail.set(seedUser.email, user.id);

    const roleId = roleByName.get(seedUser.role);
    if (roleId) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId } },
        update: {},
        create: { userId: user.id, roleId },
      });
    }

    await prisma.teamMembership.upsert({
      where: { teamId_userId: { teamId: salesTeam.id, userId: user.id } },
      update: {},
      create: { teamId: salesTeam.id, userId: user.id },
    });
  }

  const airtableSource = await prisma.leadSource.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Airtable - Website Enquiries" } },
    update: {},
    create: { tenantId: tenant.id, name: "Airtable - Website Enquiries", type: LeadSourceType.AIRTABLE },
  });
  const referralSource = await prisma.leadSource.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Referral" } },
    update: {},
    create: { tenantId: tenant.id, name: "Referral", type: LeadSourceType.REFERRAL },
  });

  const pipeline = await prisma.pipeline.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Signage Sales Pipeline" } },
    update: {},
    create: { tenantId: tenant.id, name: "Signage Sales Pipeline", isDefault: true },
  });

  const stageDefs: Array<{ name: string; order: number; probability: number; isWon?: boolean; isLost?: boolean }> = [
    { name: "New Enquiry", order: 1, probability: 10 },
    { name: "Qualified", order: 2, probability: 25 },
    { name: "Site Visit / Design", order: 3, probability: 40 },
    { name: "Quote Sent", order: 4, probability: 60 },
    { name: "Negotiation", order: 5, probability: 80 },
    { name: "Won", order: 6, probability: 100, isWon: true },
    { name: "Lost", order: 7, probability: 0, isLost: true },
  ];
  const stageByName = new Map<string, string>();
  for (const stageDef of stageDefs) {
    const stage = await prisma.stage.upsert({
      where: { pipelineId_order: { pipelineId: pipeline.id, order: stageDef.order } },
      update: { name: stageDef.name, probability: stageDef.probability },
      create: {
        pipelineId: pipeline.id,
        name: stageDef.name,
        order: stageDef.order,
        probability: stageDef.probability,
        isWon: stageDef.isWon ?? false,
        isLost: stageDef.isLost ?? false,
      },
    });
    stageByName.set(stageDef.name, stage.id);
  }

  await prisma.lossReason.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Price too high" } },
    update: {},
    create: { tenantId: tenant.id, name: "Price too high" },
  });
  await prisma.lossReason.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Went with a competitor" } },
    update: {},
    create: { tenantId: tenant.id, name: "Went with a competitor" },
  });

  const company = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: "Karachi Retail Mall",
      domain: "karachiretailmall.example",
      industry: "Retail",
      phone: "021-1112222",
      ownerId: userByEmail.get("agent@brightsigns.pk"),
    },
  });

  const contactSeeds = [
    {
      firstName: "Fahad",
      lastName: "Aslam",
      email: "fahad.aslam@karachiretailmall.example",
      phone: "0300-1234567",
      companyId: company.id,
      ownerEmail: "agent@brightsigns.pk",
    },
    {
      firstName: "Mahnoor",
      lastName: "Baig",
      email: "mahnoor.baig@example.com",
      phone: "0333-9876543",
      companyId: null,
      ownerEmail: "caller@brightsigns.pk",
    },
    {
      firstName: "Imran",
      lastName: "Chaudhry",
      email: "imran.chaudhry@example.com",
      phone: "0321-4455667",
      companyId: null,
      ownerEmail: "agent@brightsigns.pk",
    },
  ];

  const contactIds: string[] = [];
  for (const c of contactSeeds) {
    const contact = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        firstName: c.firstName,
        lastName: c.lastName,
        companyId: c.companyId,
        ownerId: userByEmail.get(c.ownerEmail),
        emails: {
          create: [{ email: c.email, normalizedEmail: normalizeEmail(c.email), isPrimary: true }],
        },
        phones: {
          create: [
            {
              phone: c.phone,
              normalizedPhoneE164: normalizePhoneToE164(c.phone) ?? c.phone,
              isPrimary: true,
            },
          ],
        },
      },
    });
    contactIds.push(contact.id);
  }

  const lead1 = await prisma.lead.create({
    data: {
      tenantId: tenant.id,
      contactId: contactIds[0],
      companyId: company.id,
      leadSourceId: airtableSource.id,
      status: LeadStatus.QUALIFIED,
      priority: LeadPriority.HIGH,
      ownerId: userByEmail.get("agent@brightsigns.pk"),
      assignedAt: new Date(),
      rawPayload: {
        airtableRecordId: "rec_seed_0001",
        enquiry: "Illuminated storefront sign for mall entrance, 20ft wide",
      },
    },
  });

  await prisma.lead.create({
    data: {
      tenantId: tenant.id,
      contactId: contactIds[1],
      leadSourceId: referralSource.id,
      status: LeadStatus.NEW,
      priority: LeadPriority.MEDIUM,
      rawPayload: { enquiry: "Shop signboard replacement, non-illuminated, 8ft x 3ft" },
    },
  });

  const deal1 = await prisma.deal.create({
    data: {
      tenantId: tenant.id,
      name: "Karachi Retail Mall - Entrance Sign",
      pipelineId: pipeline.id,
      stageId: stageByName.get("Quote Sent")!,
      contactId: contactIds[0],
      companyId: company.id,
      ownerId: userByEmail.get("agent@brightsigns.pk"),
      value: 850000,
      currency: "PKR",
      expectedCloseDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      signageDetails: {
        signType: "Illuminated Channel Letters",
        dimensions: "20ft x 4ft",
        quantity: 1,
        material: "Aluminum with acrylic face, LED illumination",
        illumination: true,
        installationLocation: "Mall main entrance facade",
        artworkStatus: "pending_approval",
      },
    },
  });

  await prisma.lead.update({
    where: { id: lead1.id },
    data: { convertedDealId: deal1.id, convertedContactId: contactIds[0], status: LeadStatus.CONVERTED },
  });

  await prisma.task.create({
    data: {
      tenantId: tenant.id,
      dealId: deal1.id,
      contactId: contactIds[0],
      assigneeId: userByEmail.get("agent@brightsigns.pk"),
      title: "Follow up on quote for entrance sign",
      description: "Call Fahad to confirm quote review status",
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: TaskStatus.PENDING,
      priority: TaskPriority.HIGH,
    },
  });

  await prisma.activity.create({
    data: {
      tenantId: tenant.id,
      type: "NOTE",
      contactId: contactIds[0],
      dealId: deal1.id,
      ownerId: userByEmail.get("agent@brightsigns.pk"),
      subject: "Site visit completed",
      body: "Measured mall entrance facade, confirmed feasibility for LED channel letters.",
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
  });

  console.log("Seed complete.");
  console.log(`Tenant: ${tenant.name} (${tenant.slug})`);
  console.log(`Seed users (password: ${SEED_PASSWORD}):`);
  for (const u of seedUsers) {
    console.log(`  - ${u.email} [${u.role}]`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
