import { normalizeEmail, normalizePhoneToE164 } from "./normalize";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Ali.Raza@BrightSigns.PK ")).toBe(
      "ali.raza@brightsigns.pk",
    );
  });
});

describe("normalizePhoneToE164", () => {
  it("converts a Pakistani national mobile number", () => {
    expect(normalizePhoneToE164("0300-1234567")).toBe("+923001234567");
  });

  it("passes through an already-international number", () => {
    expect(normalizePhoneToE164("+1 (415) 555-0100")).toBe("+14155550100");
  });

  it("converts 00-prefixed international numbers", () => {
    expect(normalizePhoneToE164("0044 7911 123456")).toBe("+447911123456");
  });

  it("returns null for obviously invalid input", () => {
    expect(normalizePhoneToE164("abc")).toBeNull();
    expect(normalizePhoneToE164("123")).toBeNull();
  });
});
