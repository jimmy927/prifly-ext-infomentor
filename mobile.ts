/**
 * The InfoMentor Hub app's own authorization, which lets this extension come
 * back days later without BankID: pair once as a device named "prifly", then
 * renew with the refresh token. Only the Swedish origins are contacted; no
 * redirect is followed on a request that carries a token, and the web sign-in
 * chain never gets a bearer header.
 *
 * Wire protocol re-implemented from the MIT-licensed infomentor-mcp by Wictor
 * Olseryd (see README).
 */

import { CookieJar, type FetchLike, type Hop, send } from "./http";
import { verifyHubSession } from "./hubwire";
import {
  followChain,
  HUB_ORIGIN,
  InfoMentorError,
  LoginRequiredError,
  NotPairedError,
  PairingRejectedError,
  validateAuthUrl,
} from "./saml";

export const AUTH_ORIGIN = "https://im.infomentor.se";
export const API_ORIGIN = "https://api-im.infomentor.se";
export const AUTH_PATH = "/Authentication/Authentication/LoginOAuth2";
export const TOKEN_PATH = "/Authentication/OAuth2/Token";
export const REVOKE_PATH = "/Authentication/OAuth2/RevokeRefreshToken";
export const SSO_BRIDGE_PATH = "/NA1/Authentication/sso";
export const DISCOVERY_PATH = "/account/pair/GetAuthenticationData";
export const CALLBACK = "InfomentorNotification://oauth2Callback";
export const CLIENT_ID = "notificationapp";
export const SCOPE = "IM2-API-NOTIFICATION";
export const DEVICE_NAME = "prifly";

const SIGN_IN_HOSTS = new Set(["im.infomentor.se", "infomentor.se", "hub.infomentor.se"]);
/** An access token is renewed this long before it ends. */
const EXPIRY_MARGIN_MS = 30_000;

/** What is kept in `api.secrets`: the device and its tokens. Never logged, never in a file. */
export type Pairing = {
  deviceId: string;
  refreshToken: string;
  accessToken: string | null;
  /** Epoch ms. */
  accessExpiresAt: number | null;
};

export type PairingStore = {
  load(): Promise<Pairing | null>;
  save(pairing: Pairing): Promise<void>;
  clear(): Promise<void>;
};

export function accessUsable(pairing: Pairing, now = Date.now()): boolean {
  return (
    pairing.accessToken !== null &&
    pairing.accessExpiresAt !== null &&
    pairing.accessExpiresAt - EXPIRY_MARGIN_MS > now
  );
}

const bearer = (pairing: Pairing): Record<string, string> => ({
  Authorization: `Bearer ${pairing.accessToken ?? ""}`,
});

function statusError(hop: Hop, stage: string): InfoMentorError {
  return new InfoMentorError(
    `The InfoMentor app sign-in stopped at ${stage} (HTTP ${hop.status}).`,
  );
}

/** Reads a token answer into a pairing; the device id is kept from `previous`. */
function readTokens(hop: Hop, previous: Pairing | { deviceId: string }, now: number): Pairing {
  if (hop.status !== 200) throw statusError(hop, "the token exchange");
  try {
    const body = JSON.parse(hop.text) as Record<string, unknown>;
    const access = body["access_token"];
    const refresh = body["refresh_token"];
    if (typeof access !== "string" || access.trim() === "") throw new Error("access");
    if (typeof refresh !== "string" || refresh.trim() === "") throw new Error("refresh");
    if (String(body["token_type"] ?? "Bearer").toLowerCase() !== "bearer") throw new Error("type");
    const expires = body["expires_in"] === undefined ? null : Number(body["expires_in"]);
    if (expires !== null && !(expires >= 0)) throw new Error("expiry");
    return {
      deviceId: previous.deviceId,
      refreshToken: refresh,
      accessToken: access,
      accessExpiresAt: expires === null ? null : now + expires * 1000,
    };
  } catch {
    throw new InfoMentorError("The token answer was unexpected; body withheld.");
  }
}

export class MobileAuth {
  private readonly fetcher: FetchLike;
  private readonly store: PairingStore;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    fetcher: FetchLike,
    store: PairingStore,
    now: () => number = Date.now,
    newId: () => string = () => crypto.randomUUID(),
  ) {
    this.fetcher = fetcher;
    this.store = store;
    this.now = now;
    this.newId = newId;
  }

  /**
   * Pairs this extension as a device of the signed-in guardian (`web` is the
   * jar of a verified Hub session). The tokens are stored before anything else
   * can fail, so a half-finished pairing can still be revoked.
   */
  async pair(web: CookieJar): Promise<Pairing> {
    const authGuid = await this.discover(web);
    const deviceId = this.newId();
    const authorize = await send(
      this.fetcher,
      `${AUTH_ORIGIN}${AUTH_PATH}?${new URLSearchParams({
        authGuid,
        DeviceIdentifier: deviceId,
        DeviceFriendlyName: DEVICE_NAME,
        DevicePlatform: "Android",
        scope: SCOPE,
        redirect_uri: CALLBACK,
        client_id: CLIENT_ID,
        response_type: "code",
        isSandBox: "false",
      }).toString()}`,
    );
    if (authorize.status !== 302) throw statusError(authorize, "the app authorization");
    const code = authorizationCode(authorize.location);
    const exchange = await send(this.fetcher, AUTH_ORIGIN + TOKEN_PATH, {
      form: {
        code,
        client_id: CLIENT_ID,
        client_secret: "NONE",
        redirect_uri: CALLBACK,
        grant_type: "authorization_code",
      },
    });
    const pairing = readTokens(exchange, { deviceId }, this.now());
    await this.store.save(pairing);
    return pairing;
  }

  /** Hub's own description of the app configuration, checked against the Swedish one. */
  private async discover(web: CookieJar): Promise<string> {
    const hop = await send(this.fetcher, HUB_ORIGIN + DISCOVERY_PATH, {
      method: "POST",
      jar: web,
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    if (hop.status !== 200) throw statusError(hop, "the app discovery");
    try {
      const body = JSON.parse(hop.text) as Record<string, string>;
      const expected: Record<string, [string, string]> = {
        authenticationUrl: [AUTH_ORIGIN, AUTH_PATH],
        tokenUrl: [AUTH_ORIGIN, TOKEN_PATH],
        revokeRefreshTokenUrl: [AUTH_ORIGIN, REVOKE_PATH],
        apiUrl: [API_ORIGIN, ""],
      };
      for (const [name, [origin, path]] of Object.entries(expected)) {
        const url = new URL(body[name] ?? "");
        if (url.origin !== origin || url.hash !== "" || url.pathname.replace(/\/$/, "") !== path) {
          throw new Error("endpoint");
        }
      }
      if (body["clientId"] !== CLIENT_ID) throw new Error("client");
      const guids = new URL(body["authenticationUrl"] ?? "").searchParams.getAll("authGuid");
      if (guids.length !== 1 || guids[0] === "" || guids[0] === undefined) throw new Error("guid");
      return guids[0];
    } catch {
      throw new InfoMentorError("The app discovery did not match the known Swedish configuration.");
    }
  }

  /** The refresh grant. The rotated tokens are stored before the call returns. */
  async refresh(pairing: Pairing): Promise<Pairing> {
    const hop = await this.refreshRequest(pairing);
    if (hop.status === 400 || hop.status === 401) {
      throw new PairingRejectedError(
        "InfoMentor rejected the stored pairing: log in with BankID again.",
      );
    }
    const rotated = readTokens(hop, pairing, this.now());
    await this.store.save(rotated);
    return rotated;
  }

  private refreshRequest(pairing: Pairing): Promise<Hop> {
    return send(this.fetcher, AUTH_ORIGIN + TOKEN_PATH, {
      form: {
        refresh_token: pairing.refreshToken,
        client_id: CLIENT_ID,
        client_secret: "NONE",
        grant_type: "refresh_token",
        scope: SCOPE,
      },
    });
  }

  /** A pairing whose access token is good for a while, refreshing it if need be. */
  async withAccess(pairing: Pairing): Promise<Pairing> {
    return accessUsable(pairing, this.now()) ? pairing : await this.refresh(pairing);
  }

  /**
   * Fresh Hub cookies from the pairing, without BankID: the access token buys
   * a web sign-in URL, which is followed with no bearer header. A 401 from the
   * bridge means one refresh and one retry; a second 401 means a new login.
   */
  async renewHub(): Promise<CookieJar> {
    let pairing = await this.store.load();
    if (pairing === null) throw new NotPairedError("InfoMentor is not paired: log in with BankID.");
    pairing = await this.withAccess(pairing);
    let bridge = await this.bridge(pairing);
    if (bridge.status === 401) {
      pairing = await this.refresh(pairing);
      bridge = await this.bridge(pairing);
      if (bridge.status === 401) {
        throw new PairingRejectedError(
          "InfoMentor rejected the access after a refresh: log in again.",
        );
      }
    }
    if (bridge.status !== 200) throw statusError(bridge, "the mobile sign-in bridge");
    const signIn = approvedSignInUrl(bridge.text);
    // A fresh jar and no Authorization header: the web chain never sees the token.
    const jar = new CookieJar();
    await followChain(this.fetcher, jar, await send(this.fetcher, signIn, { jar }));
    await verifyHubSession(this.fetcher, jar);
    return jar;
  }

  private bridge(pairing: Pairing): Promise<Hop> {
    return send(this.fetcher, API_ORIGIN + SSO_BRIDGE_PATH, { headers: bearer(pairing) });
  }

  /**
   * Revokes the pairing at InfoMentor and, once the old refresh token is
   * rejected, clears it here. Anything less certain keeps the pairing and says so.
   */
  async revoke(): Promise<"revoked" | "already-dead"> {
    const stored = await this.store.load();
    if (stored === null) throw new InfoMentorError("InfoMentor is not paired.");
    let pairing: Pairing;
    try {
      pairing = await this.withAccess(stored);
    } catch (error) {
      if (!(error instanceof LoginRequiredError)) throw error;
      // The refresh token is already rejected: nothing is left to revoke.
      await this.store.clear();
      return "already-dead";
    }
    const hop = await send(
      this.fetcher,
      `${AUTH_ORIGIN}${REVOKE_PATH}?${new URLSearchParams({ refreshToken: pairing.refreshToken }).toString()}`,
      { headers: bearer(pairing) },
    );
    if (![200, 204, 400, 401].includes(hop.status)) {
      throw new InfoMentorError(`Revocation failed (HTTP ${hop.status}); the pairing is kept.`);
    }
    if (
      (hop.status === 200 || hop.status === 204) &&
      hop.text.trim() !== "" &&
      hop.text.trim() !== "true"
    ) {
      throw new InfoMentorError("Revocation was not confirmed; the pairing is kept.");
    }
    const check = await this.refreshRequest(pairing);
    if (check.status === 200) {
      await this.store.save(readTokens(check, pairing, this.now()));
      throw new InfoMentorError("The revoked token still renews; the pairing is kept.");
    }
    if (check.status !== 400 && check.status !== 401) {
      throw new InfoMentorError(
        `Revocation is inconclusive (HTTP ${check.status}); the pairing is kept.`,
      );
    }
    await this.store.clear();
    return "revoked";
  }
}

function authorizationCode(location: string | null): string {
  try {
    const callback = new URL(location ?? "");
    const codes = callback.searchParams.getAll("code");
    if (
      callback.protocol.toLowerCase() !== "infomentornotification:" ||
      callback.hostname.toLowerCase() !== "oauth2callback" ||
      callback.hash !== "" ||
      callback.searchParams.has("error") ||
      codes.length !== 1 ||
      codes[0] === undefined ||
      codes[0] === ""
    ) {
      throw new Error("callback");
    }
    return codes[0];
  } catch {
    throw new InfoMentorError("The app authorization did not return the expected code callback.");
  }
}

/** The bridge answers a JSON string or bare text: a sign-in URL on an approved host. */
function approvedSignInUrl(text: string): string {
  let value: unknown = text.trim();
  try {
    value = JSON.parse(text);
  } catch {
    // Bare text.
  }
  if (typeof value !== "string" || /[\s\\]/.test(value)) {
    throw new InfoMentorError("The sign-in bridge did not return a sign-in URL; answer withheld.");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !SIGN_IN_HOSTS.has(url.host) || url.hash !== "")
      throw new Error();
    return validateAuthUrl(value);
  } catch {
    throw new InfoMentorError("The sign-in bridge URL was not approved; not followed.");
  }
}
