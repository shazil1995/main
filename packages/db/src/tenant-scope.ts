import type { PrismaClient } from "../generated/client";

/**
 * Prisma model names that carry a direct `tenantId` scalar column.
 * Models scoped only through a parent relation (e.g. ContactEmail via
 * Contact, Session via User) are intentionally excluded: their isolation
 * is enforced by scoping the parent lookup, and the extension below would
 * otherwise reject writes on them for lacking a tenantId column.
 *
 * WebhookEvent is excluded: tenantId is nullable there because some
 * inbound webhooks arrive before tenant resolution; it must be scoped
 * explicitly in ingestion code (Phase 3), not by this generic guard.
 *
 * Keep in sync with prisma/schema.prisma.
 */
export const TENANT_SCOPED_MODELS = new Set([
  "User",
  "Team",
  "Role",
  "Contact",
  "Company",
  "LeadSource",
  "Lead",
  "Pipeline",
  "LossReason",
  "Deal",
  "Product",
  "Quote",
  "Activity",
  "Task",
  "Tag",
  "TagAssignment",
  "CustomFieldDefinition",
  "CustomFieldValue",
  "Attachment",
  "TelephonyConnection",
  "BusinessPhoneNumber",
  "Call",
  "CallRecording",
  "CallTranscript",
  "MailboxConnection",
  "EmailThread",
  "EmailMessage",
  "EmailTemplate",
  "CommunicationConsent",
  "SuppressionEntry",
  "Meeting",
  "Workflow",
  "WorkflowVersion",
  "IntegrationConnection",
  "ExternalRecordMap",
  "SyncRun",
  "Notification",
  "AuditLog",
]);

const READ_MANY_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

const SINGLE_RECORD_OPS = new Set(["update", "delete"]);

/**
 * Returns a Prisma Client extended so that every query against a
 * tenant-scoped model is confined to `tenantId`, regardless of what a
 * caller passes in `where`/`data`. This is the application's primary
 * tenant-isolation enforcement point (see DECISIONS.md and
 * apps/api/test/tenant-isolation.e2e-spec.ts).
 *
 * Rules:
 *  - reads/updateMany/deleteMany: tenantId is forced into `where`.
 *  - update/delete (unique-by-id): tenantId is forced into `where`; Prisma
 *    throws "record not found" if the row belongs to another tenant,
 *    since the compound where no longer matches.
 *  - findUnique/findUniqueOrThrow: `where` must stay unique-key-only, so
 *    the result's tenantId is checked after the call and nulled out
 *    (or thrown, for the *OrThrow variant) if it belongs to another tenant.
 *  - create/createMany/upsert: tenantId is forced into the written data,
 *    overriding anything a caller supplied.
 *
 * Raw queries ($queryRaw / $executeRaw) are NOT covered by this guard and
 * must not be used for tenant-owned data; use the query builder instead.
 */
export function forTenant<T extends PrismaClient>(prisma: T, tenantId: string): T {
  if (!tenantId) {
    throw new Error("forTenant() requires a non-empty tenantId");
  }

  return prisma.$extends({
    name: `tenant-scope:${tenantId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const typedArgs = args as Record<string, unknown>;

          if (operation === "findUnique" || operation === "findUniqueOrThrow") {
            const result = await query(args);
            if (
              result &&
              typeof result === "object" &&
              "tenantId" in result &&
              (result as { tenantId?: string }).tenantId !== tenantId
            ) {
              if (operation === "findUniqueOrThrow") {
                throw new Error(`${model} not found for this tenant`);
              }
              return null;
            }
            return result;
          }

          if (READ_MANY_OPS.has(operation) || SINGLE_RECORD_OPS.has(operation)) {
            typedArgs.where = { ...(typedArgs.where as object | undefined), tenantId };
            return query(typedArgs);
          }

          if (operation === "create") {
            typedArgs.data = { ...(typedArgs.data as object), tenantId };
            return query(typedArgs);
          }

          if (operation === "createMany") {
            const data = typedArgs.data;
            typedArgs.data = Array.isArray(data)
              ? data.map((row) => ({ ...row, tenantId }))
              : { ...(data as object), tenantId };
            return query(typedArgs);
          }

          if (operation === "upsert") {
            typedArgs.where = { ...(typedArgs.where as object | undefined), tenantId };
            typedArgs.create = { ...(typedArgs.create as object), tenantId };
            return query(typedArgs);
          }

          return query(typedArgs);
        },
      },
    },
  }) as T;
}
