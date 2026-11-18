/**
 * The web sign-in chains (Stockholm's SSO, SAML, InfoMentor): redirects and
 * auto-submitted forms between approved hosts only. The same hop logic serves
 * the BankID login and the renewal from the mobile app's sign-in URL. No hop
 * ever carries a bearer token: this module only knows cookies.
 */

import { parseLoginPage } from "./html";
import { type CookieJar, type FetchLike, type Hop, send } from "./http";

export const SSO_LOGIN_URL = "https://sso.infomentor.se/login.ashx?idp=stockholm_par";
export const HUB_ORIGIN = "https://hub.infomentor.se";
export const MAX_HOPS = 12;

const EXACT_HOSTS = new Set([
  "infomentor.se",
  "hub.infomentor.se",
  "sso.infomentor.se",
  "im.infomentor.se",
]);

/** A failure the reader can read: no token, cookie or page text ever goes in one. */
export class InfoMentorError extends Error {
  override readonly name: string = "InfoMentorError";
}

/** The Hub session or the pairing is gone: the reader must log in with BankID again. */
export class LoginRequiredError extends InfoMentorError {
  override readonly name: string = "LoginRequiredError";
}

/** There is no pairing at all (never logged in, or revoked). */
export class NotPairedError extends LoginRequiredError {
  override readonly name: string = "NotPairedError";
}

/** InfoMentor refused the stored pairing's tokens. */
export class PairingRejectedError extends LoginRequiredError {
  override readonly name: string = "PairingRejectedError";
}

/** HTTPS on an InfoMentor or Stockholm stad host, or an error. Returns the resolved URL. */
export function validateAuthUrl(url: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    throw new InfoMentorError("An authentication redirect had an invalid address.");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !(EXACT_HOSTS.has(host) || host.endsWith(".stockholm.se"))) {
    throw new InfoMentorError(
      `An authentication redirect pointed outside the approved providers (host: ${host || "missing"}).`,
    );
  }
  return parsed.toString();
}

export type NextHop = { method: "GET" | "POST"; url: string; form?: Record<string, string> };

/** The next validated hop after a SAML response, or null when the chain is done. */
export function nextHop(hop: Hop): NextHop | null {
  if (hop.status >= 300 && hop.status < 400) {
    if (hop.location === null) throw new InfoMentorError("A SAML redirect had no destination.");
    return { method: "GET", url: validateAuthUrl(hop.location, hop.url) };
  }
  if (hop.status >= 400)
    throw new InfoMentorError(`The sign-in chain failed (HTTP ${hop.status}).`);
  const page = parseLoginPage(hop.text);
  let form = page.formWith("SAMLResponse", "SAMLRequest");
  if (form === null && hop.text.toLowerCase().includes("login in progress"))
    form = page.forms[0] ?? null;
  if (form === null) return null;
  return { method: "POST", url: validateAuthUrl(form.action, hop.url), form: form.fields };
}

/** Follows the chain from `first` to its end, in `jar`. */
export async function followChain(fetcher: FetchLike, jar: CookieJar, first: Hop): Promise<Hop> {
  let hop = first;
  for (let n = 0; n < MAX_HOPS; n += 1) {
    const next = nextHop(hop);
    if (next === null) return hop;
    hop = await send(fetcher, next.url, {
      method: next.method,
      jar,
      ...(next.form === undefined ? {} : { form: next.form }),
    });
  }
  throw new InfoMentorError("The SAML redirect/form limit was reached.");
}
