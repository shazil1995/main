const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export interface CurrentUser {
  id: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  permissions: string[];
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  emails: Array<{ email: string; isPrimary: boolean }>;
  phones: Array<{ phone: string; isPrimary: boolean }>;
  company: { name: string } | null;
  createdAt: string;
}

class ApiError extends Error {}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return Array.isArray(body.message) ? body.message.join(", ") : body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export function getCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|; )csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function fetchCsrfToken(): Promise<string> {
  const res = await fetch(`${API_URL}/auth/csrf`, { credentials: "include" });
  if (!res.ok) throw new ApiError(await parseErrorMessage(res));
  const data = await res.json();
  return data.csrfToken;
}

export async function login(email: string, password: string): Promise<{ user: CurrentUser }> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new ApiError(await parseErrorMessage(res));
  return res.json();
}

export async function logout(): Promise<void> {
  const csrfToken = getCsrfTokenFromCookie();
  await fetch(`${API_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
  });
}

export async function fetchMe(): Promise<CurrentUser> {
  const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
  if (!res.ok) throw new ApiError(await parseErrorMessage(res));
  return res.json();
}

export async function fetchContacts(): Promise<Contact[]> {
  const res = await fetch(`${API_URL}/contacts`, { credentials: "include" });
  if (!res.ok) throw new ApiError(await parseErrorMessage(res));
  return res.json();
}

export async function createContact(input: {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}): Promise<Contact> {
  const csrfToken = getCsrfTokenFromCookie();
  const res = await fetch(`${API_URL}/contacts`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ApiError(await parseErrorMessage(res));
  return res.json();
}
