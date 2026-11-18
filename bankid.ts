/**
 * Stockholm stad's BankID login into InfoMentor: start an order, poll it, and
 * once the reader has approved it on their phone follow the SAML chain into
 * the Hub. The result is a cookie jar with a verified Hub session.
 */

import { parseLoginPage } from "./html";
import { type CookieJar, type FetchLike, type Hop, send } from "./http";
import { verifyHubSession } from "./hubwire";
import {
  followChain,
  InfoMentorError,
  MAX_HOPS,
  type NextHop,
  SSO_LOGIN_URL,
  validateAuthUrl,
} from "./saml";

export type BankIdOrder = {
  /** The page whose query string polls the order. */
  pageUrl: string;
  reference: string;
  /** The autostart token, when the order has one (for a link on the reader's phone). */
  autostartToken: string | null;
  /** The animated QR's current text, when the order has one. */
  qrData: string | null;
};

export type BankIdState = "PENDING" | "USER_SIGN" | "OK";

const STATES = new Set(["PENDING", "USER_SIGN", "OK", "ERROR", "CANCELLED"]);

/** `bankid:///?autostarttoken=…`: opens the BankID app on the phone this link is opened on. */
export function autostartLink(token: string): string {
  return `bankid:///?${new URLSearchParams({ autostarttoken: token, redirect: "null" }).toString()}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Walks Stockholm's SSO from its entry point to the page that starts a BankID order. */
async function findOrderPage(fetcher: FetchLike, jar: CookieJar): Promise<string> {
  let next: NextHop = { method: "GET", url: SSO_LOGIN_URL };
  for (let n = 0; n < MAX_HOPS; n += 1) {
    const hop = await send(fetcher, next.url, {
      method: next.method,
      jar,
      ...(next.form === undefined ? {} : { form: next.form }),
    });
    const following = orderStep(hop);
    if (following === null) return hop.url;
    next = following;
  }
  throw new InfoMentorError("The SSO redirect limit was reached.");
}

/** Where the SSO leads on from this response, or null at the page that starts the order. */
function orderStep(hop: Hop): NextHop | null {
  if (hop.status >= 300 && hop.status < 400) {
    if (hop.location === null) throw new InfoMentorError("The SSO redirect had no destination.");
    return { method: "GET", url: validateAuthUrl(hop.location, hop.url) };
  }
  if (hop.status >= 400) throw new InfoMentorError(`The BankID start failed (HTTP ${hop.status}).`);
  const page = parseLoginPage(hop.text);
  const saml = page.formWith("SAMLRequest");
  if (saml !== null) {
    return { method: "POST", url: validateAuthUrl(saml.action, hop.url), form: saml.fields };
  }
  if (page.mbidHref === null) return null;
  return { method: "GET", url: validateAuthUrl(page.mbidHref, hop.url) };
}

function withQuery(url: string, query: Record<string, string>): string {
  return `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(query).toString()}`;
}

/**
 * Starts an order. `qr` asks for the animated QR (to scan from a screen), `url`
 * for an autostart token (to open on the phone itself).
 */
export async function beginBankId(
  fetcher: FetchLike,
  jar: CookieJar,
  method: "qr" | "url",
): Promise<BankIdOrder> {
  const pageUrl = await findOrderPage(fetcher, jar);
  const hop = await send(
    fetcher,
    withQuery(pageUrl, { initialize: method === "url" ? "bankid" : "qr" }),
    {
      jar,
    },
  );
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(hop.text) as Record<string, unknown>;
  } catch {
    throw new InfoMentorError("Unexpected BankID start answer; values withheld.");
  }
  const reference = payload["order"];
  const token = payload["token"];
  const qr = payload["qrData"];
  if (!nonEmpty(reference) || !(nonEmpty(token) || nonEmpty(qr))) {
    throw new InfoMentorError("Unexpected BankID start answer; values withheld.");
  }
  return {
    pageUrl,
    reference,
    autostartToken: nonEmpty(token) ? token : null,
    qrData: nonEmpty(qr) ? qr : null,
  };
}

/** One poll. `ERROR` and `CANCELLED` are errors; the QR text moves on with every poll. */
export async function pollBankId(
  fetcher: FetchLike,
  jar: CookieJar,
  order: BankIdOrder,
  now = Date.now(),
): Promise<{ state: BankIdState; qrData: string | null }> {
  const hop = await send(
    fetcher,
    withQuery(order.pageUrl, { verifyorder: order.reference, _: String(now) }),
    { jar },
  );
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(hop.text) as Record<string, unknown>;
  } catch {
    throw new InfoMentorError("Unexpected BankID poll answer; values withheld.");
  }
  const state = payload["state"];
  const qr = payload["qrData"];
  if (typeof state !== "string" || !STATES.has(state) || (qr != null && typeof qr !== "string")) {
    throw new InfoMentorError("Unexpected BankID poll answer; values withheld.");
  }
  if (state === "ERROR" || state === "CANCELLED") {
    throw new InfoMentorError("The BankID order was rejected, cancelled or timed out.");
  }
  return { state: state as BankIdState, qrData: typeof qr === "string" && qr !== "" ? qr : null };
}

/** After approval: follow the SAML chain into the Hub and check the session works. */
export async function finishBankId(
  fetcher: FetchLike,
  jar: CookieJar,
  order: BankIdOrder,
): Promise<void> {
  const first = await send(fetcher, order.pageUrl, { jar });
  await followChain(fetcher, jar, first);
  await verifyHubSession(fetcher, jar);
}
