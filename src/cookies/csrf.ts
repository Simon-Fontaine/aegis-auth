import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import type { AegisAuthConfig } from "../config";

export function createCsrfCookie({
  csrfToken,
  config,
}: { csrfToken: string; config: AegisAuthConfig }): string {
  return serializeCookie(config.csrf.cookieName, csrfToken, {
    maxAge: config.csrf.maxAgeSeconds,
    secure: config.csrf.cookieSecure,
    httpOnly: config.csrf.cookieHttpOnly,
    sameSite: config.csrf.cookieSameSite,
    path: config.csrf.cookiePath,
    domain: config.csrf.cookieDomain,
  });
}

export function clearCsrfCookie({
  config,
}: { config: AegisAuthConfig }): string {
  return serializeCookie(config.csrf.cookieName, "", {
    maxAge: 0,
    secure: config.csrf.cookieSecure,
    httpOnly: config.csrf.cookieHttpOnly,
    sameSite: config.csrf.cookieSameSite,
  });
}

export function getCsrfToken({
  cookieHeader,
  config,
}: { cookieHeader: string; config: AegisAuthConfig }): string | undefined {
  const csrfToken = parseCookie(cookieHeader)[config.csrf.cookieName];
  return csrfToken;
}
