import { SetMetadata } from "@nestjs/common";
import type { PermissionKey } from "@signage-crm/db";

export const PERMISSIONS_METADATA_KEY = "requiredPermissions";

export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);
