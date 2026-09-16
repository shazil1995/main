import type { Request } from "express";

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  permissions: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  tenantId?: string;
  sessionId?: string;
}
