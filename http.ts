/**
 * HTTP for the InfoMentor protocols: an injected `fetch` that never follows a
 * redirect by itself (`redirect: "manual"`), and a small cookie jar. Both
 * the BankID/SAML chain and the Hub need to see every hop: a redirect is where
 * a bearer token would leak, or a session would silently be lost.
 */

/** What the extension needs of `fetch`; tests inject a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type Cookie = {
  name: string;
  value: string;
  /** Lower-case host without a leading dot. */
  domain: string;
  /** True for a cookie set without a Domain attribute: sent to that exact host only. */
  hostOnly: boolean;
  path: string;
  /** Epoch ms, or null for a session cookie. */
  expires: number | null;
};

/** Cookies of one web session. They live in memory only: never written anywhere. */
export class CookieJar {
  private cookies: Cookie[] = [];

  get size(): number {
    return this.cookies.length;
  }

  clear(): void {
    this.cookies = [];
  }

  /** Stores the `Set-Cookie` headers of a response received from `url`. */
  store(url: string, setCookies: string[], now = Date.now()): void {
    const target = new URL(url);
    for (const line of setCookies) {
      const cookie = parseSetCookie(line, target, now);
      if (cookie === null) continue;
      this.cookies = this.cookies.filter(
        (each) =>
          !(
            each.name === cookie.name &&
            each.domain === cookie.domain &&
            each.path === cookie.path
          ),
      );
      if (cookie.expires === null || cookie.expires > now) this.cookies.push(cookie);
    }
  }

  /** The `Cookie` header for a request to `url`, or null when no cookie applies. */
  header(url: string, now = Date.now()): string | null {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const sent = this.cookies
      .filter((cookie) => cookie.expires === null || cookie.expires > now)
      .filter((cookie) => domainMatches(host, cookie))
      .filter((cookie) => pathMatches(target.pathname, cookie.path))
      .sort((a, b) => b.path.length - a.path.length);
    return sent.length === 0 ? null : sent.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

function domainMatches(host: string, cookie: Cookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

function defaultPath(pathname: string): string {
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

function parseSetCookie(line: string, target: URL, now: number): Cookie | null {
  const [pair, ...attributes] = line.split(";").map((part) => part.trim());
  const equals = pair?.indexOf("=") ?? -1;
  if (pair === undefined || equals <= 0) return null;
  const cookie: Cookie = {
    name: pair.slice(0, equals),
    value: pair.slice(equals + 1),
    domain: target.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultPath(target.pathname),
    expires: null,
  };
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at < 0 ? attribute : attribute.slice(0, at)).toLowerCase();
    const value = at < 0 ? "" : attribute.slice(at + 1);
    if (!applyAttribute(cookie, key, value, now)) return null;
  }
  return cookie;
}

/** Applies one cookie attribute; false when the cookie must be rejected. */
function applyAttribute(cookie: Cookie, key: string, value: string, now: number): boolean {
  if (key === "domain" && value !== "") {
    const domain = value.replace(/^\./, "").toLowerCase();
    // A cookie may only widen to a parent domain of the host that set it.
    if (cookie.domain !== domain && !cookie.domain.endsWith(`.${domain}`)) return false;
    cookie.domain = domain;
    cookie.hostOnly = false;
  } else if (key === "path" && value.startsWith("/")) {
    cookie.path = value;
  } else if (key === "max-age" && /^-?\d+$/.test(value)) {
    cookie.expires = now + Number(value) * 1000;
  } else if (key === "expires" && cookie.expires === null) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) cookie.expires = time;
  }
  return true;
}

/** A response read once: status, where it came from, where it points, and its body text. */
export type Hop = {
  status: number;
  /** The URL that was requested. */
  url: string;
  /** The `Location` header resolved against `url`, for a 3xx. */
  location: string | null;
  text: string;
  headers: Headers;
};

export type RequestSpec = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent as an urlencoded form. */
  form?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** The jar whose cookies are sent and updated; none means no cookies at all. */
  jar?: CookieJar;
};

/** One request, no redirect followed. The body is read as text. */
export async function send(fetcher: FetchLike, url: string, spec: RequestSpec = {}): Promise<Hop> {
  const headers: Record<string, string> = {
    "User-Agent": "prifly-ext-infomentor",
    ...spec.headers,
  };
  let body: string | undefined;
  if (spec.form !== undefined) {
    body = new URLSearchParams(spec.form).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    headers["Content-Type"] = "application/json";
  }
  const cookie = spec.jar?.header(url) ?? null;
  if (cookie !== null) headers["Cookie"] = cookie;
  const init: RequestInit = {
    method: spec.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  };
  if (body !== undefined) init.body = body;
  const response = await fetcher(url, init);
  spec.jar?.store(url, response.headers.getSetCookie());
  const location = response.headers.get("location");
  return {
    status: response.status,
    url,
    location: location === null ? null : new URL(location, url).toString(),
    text: await response.text(),
    headers: response.headers,
  };
}

/** Like `send`, for a body that is a file: the bytes, capped. */
export async function sendBinary(
  fetcher: FetchLike,
  url: string,
  jar: CookieJar,
  maxBytes: number,
): Promise<{ status: number; location: string | null; bytes: Uint8Array | null }> {
  const headers: Record<string, string> = { "User-Agent": "prifly-ext-infomentor" };
  const cookie = jar.header(url);
  if (cookie !== null) headers["Cookie"] = cookie;
  const response = await fetcher(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  jar.store(url, response.headers.getSetCookie());
  const location = response.headers.get("location");
  const resolved = location === null ? null : new URL(location, url).toString();
  if (response.status !== 200) return { status: response.status, location: resolved, bytes: null };
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > maxBytes) return { status: 413, location: null, bytes: null };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) return { status: 413, location: null, bytes: null };
  return { status: 200, location: null, bytes };
}
