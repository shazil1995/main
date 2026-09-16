// Matches apps/api/.env.test; set before any module that constructs
// PrismaClient is instantiated, so tests never touch the dev database.
process.env.DATABASE_URL =
  "postgresql://signage_crm:signage_crm_dev@localhost:5432/signage_crm_test?schema=public";
process.env.NODE_ENV = "test";

import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";

describe("Tenant isolation (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const PASSWORD = "Passw0rd!123";
  let tenantAId: string;
  let tenantBId: string;
  let contactAId: string;

  async function login(email: string) {
    const server = app.getHttpServer();
    const agent = request.agent(server);
    const csrfRes = await agent.get("/api/auth/csrf").expect(200);
    const csrfToken: string = csrfRes.body.csrfToken;

    const loginRes = await agent
      .post("/api/auth/login")
      .set("x-csrf-token", csrfToken)
      .send({ email, password: PASSWORD })
      .expect(200);

    return { agent, csrfToken: loginRes.body.csrfToken as string };
  }

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix("api");
    await app.init();

    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(PASSWORD, 4);

    const tenantA = await prisma.tenant.create({
      data: { name: "Tenant A Signs", slug: `tenant-a-${Date.now()}` },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: "Tenant B Signs", slug: `tenant-b-${Date.now()}` },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    for (const key of ["contacts:read", "contacts:write"]) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } });
    }

    for (const tenant of [tenantA, tenantB]) {
      const role = await prisma.role.create({
        data: { tenantId: tenant.id, name: "administrator", isSystem: true },
      });
      for (const key of ["contacts:read", "contacts:write"]) {
        const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
      }
      const email = tenant.id === tenantA.id ? "owner-a@example.test" : "owner-b@example.test";
      const user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email,
          normalizedEmail: email,
          passwordHash,
          firstName: "Owner",
          lastName: tenant.id === tenantA.id ? "A" : "B",
          status: "ACTIVE",
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await app.close();
  });

  it("lets a tenant create and read back its own contact", async () => {
    const { agent, csrfToken } = await login("owner-a@example.test");

    const createRes = await agent
      .post("/api/contacts")
      .set("x-csrf-token", csrfToken)
      .send({ firstName: "Fahad", lastName: "Aslam", email: "fahad@example.test" })
      .expect(201);

    contactAId = createRes.body.id;
    expect(createRes.body.tenantId).toBe(tenantAId);

    const listRes = await agent.get("/api/contacts").expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(contactAId);
  });

  it("never returns another tenant's contacts in a list", async () => {
    const { agent } = await login("owner-b@example.test");
    const listRes = await agent.get("/api/contacts").expect(200);
    expect(listRes.body).toEqual([]);
  });

  it("returns 404, not another tenant's record, for a direct ID lookup across tenants", async () => {
    const { agent } = await login("owner-b@example.test");
    await agent.get(`/api/contacts/${contactAId}`).expect(404);
  });

  it("still lets the owning tenant fetch that same contact by ID", async () => {
    const { agent } = await login("owner-a@example.test");
    const res = await agent.get(`/api/contacts/${contactAId}`).expect(200);
    expect(res.body.id).toBe(contactAId);
  });

  it("rejects requests with no session cookie", async () => {
    await request(app.getHttpServer()).get("/api/contacts").expect(401);
  });

  it("rejects a mutating request missing the CSRF header even with a valid session", async () => {
    const { agent } = await login("owner-a@example.test");
    await agent.post("/api/contacts").send({ firstName: "No", lastName: "Csrf" }).expect(403);
  });
});
