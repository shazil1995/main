/**
 * Deterministic normalizers used for duplicate-contact matching.
 * Documented assumption (see DECISIONS.md): phone normalization defaults
 * to Pakistan (+92) for bare national numbers, since that is the CRM's
 * home market. A future phase should replace this with a full E.164
 * library (e.g. google-libphonenumber) once other countries are onboarded.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const DEFAULT_COUNTRY_CALLING_CODE = "92";

export function normalizePhoneToE164(
  rawPhone: string,
  defaultCallingCode: string = DEFAULT_COUNTRY_CALLING_CODE,
): string | null {
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/[^\d+]/g, "");

  if (digits.startsWith("00")) {
    digits = `+${digits.slice(2)}`;
  }

  if (digits.startsWith("+")) {
    const rest = digits.slice(1).replace(/\D/g, "");
    if (rest.length < 8 || rest.length > 15) return null;
    return `+${rest}`;
  }

  digits = digits.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  if (digits.length < 7 || digits.length > 14) return null;

  return `+${defaultCallingCode}${digits}`;
}
