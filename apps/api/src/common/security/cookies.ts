import type { CookieOptions } from "express";

export const SESSION_COOKIE_NAME = "sid";
export const CSRF_COOKIE_NAME = "csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const isProduction = process.env.NODE_ENV === "production";

export const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_MS,
};

export const csrfCookieOptions: CookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_MS,
};
