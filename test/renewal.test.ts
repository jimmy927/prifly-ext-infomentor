import { expect, test } from "bun:test";
import type { Pairing } from "../mobile";
import { loggedIn, rig } from "./helpers";
import type { Call, World } from "./world";

const stored = (secrets: Map<string, string>): Pairing =>
  JSON.parse(secrets.get("pairing") ?? "null") as Pairing;

/** Paths that may carry a bearer token: the app's own token-bearing endpoints, nothing else. */
const BEARER_PATHS = new Set([
  "/NA1/Authentication/sso",
  "/Authentication/OAuth2/RevokeRefreshToken",
]);

const bearerCalls = (calls: Call[]) =>
  calls.filter((c) => c.headers["authorization"] !== undefined);

/** A new extension process: only the sealed secrets survive, no Hub cookies. */
function restarted(r: { secrets: Map<string, string>; world: World; stop: () => void }) {
  r.stop();
  return rig({ world: r.world, secrets: r.secrets });
}

test("days later, with only the stored pairing, a read works without BankID", async () => {
  const first = await loggedIn();
  const pollsAtLogin = first.world.polls;
  const later = restarted(first);
  expect(await later.call("infomentor_status")).toBe("Paired · renews on the next read.");

  expect(await later.call("infomentor_pupils")).toContain("Anna Test");
  expect(first.world.polls).toBe(pollsAtLogin);
  expect(first.world.callsTo("/NA1/Authentication/sso")).toHaveLength(1);
  expect(first.world.callsTo("/Authentication/OAuth2/Token")).toHaveLength(1);
  expect(await later.call("infomentor_status")).toBe("Signed in · paired.");
});

test("a 401 from the sign-in bridge refreshes once, persists the rotated token and retries", async () => {
  const first = await loggedIn();
  const later = restarted(first);
  first.world.expireAccess();
  expect(await later.call("infomentor_pupils")).toContain("Anna Test");

  expect(first.world.callsTo("/NA1/Authentication/sso")).toHaveLength(2);
  const refreshes = first.world
    .callsTo("/Authentication/OAuth2/Token")
    .filter((c) => c.body.includes("grant_type=refresh_token"));
  expect(refreshes).toHaveLength(1);
  expect(new URLSearchParams(refreshes[0]?.body).get("refresh_token")).toBe("REFRESH-1");
  expect(new URLSearchParams(refreshes[0]?.body).get("client_secret")).toBe("NONE");
  expect(stored(first.secrets).refreshToken).toBe("REFRESH-2");
  expect(stored(first.secrets).accessToken).toBe("ACCESS-2");
});

test("a rotated refresh token is saved before anything after it can fail", async () => {
  const first = await loggedIn();
  const later = restarted(first);
  // The stored access token is long past its end, so renewal starts with a refresh ...
  first.secrets.set("pairing", JSON.stringify({ ...stored(first.secrets), accessExpiresAt: 1 }));
  // ... and the sign-in bridge then fails.
  first.world.failBridge = true;
  expect(await later.call("infomentor_pupils")).toContain("Not done");
  expect(stored(first.secrets).refreshToken).toBe("REFRESH-2");
  expect(first.world.refreshToken).toBe("REFRESH-2");
});

test("the Hub ending the session (redirect) triggers one renewal and one retry", async () => {
  const r = await loggedIn();
  expect(await r.call("infomentor_timetable", { date: "2026-11-18" })).toContain("Anna Test");
  const before = r.world.callsTo("/timetable/timetable/gettimetablelist").length;
  r.world.expireHub();
  expect(await r.call("infomentor_timetable", { date: "2026-11-18" })).toContain("Anna Test");
  // One failed call (a redirect to the login), then the retry after the renewal: both pupils.
  expect(r.world.callsTo("/timetable/timetable/gettimetablelist").length - before).toBe(3);
  expect(r.world.callsTo("/NA1/Authentication/sso")).toHaveLength(1);
});

test("a pairing InfoMentor rejects asks for a new BankID login and says so in the status line", async () => {
  const first = await loggedIn();
  const later = restarted(first);
  first.world.refreshToken = "someone-else";
  first.secrets.set("pairing", JSON.stringify({ ...stored(first.secrets), accessExpiresAt: 1 }));
  const text = await later.call("infomentor_timetable", {});
  expect(text).toContain("Not signed in");
  expect(text).toContain("infomentor_login");
  expect(later.fake.statuses.at(-1)).toBe(
    "Pairing rejected by InfoMentor: log in with BankID again",
  );
  // The pairing is kept: the reader decides (revoke or log in again).
  expect(first.secrets.has("pairing")).toBe(true);
});

test("a fresh install says not paired, not rejected, on its first read", async () => {
  const r = rig();
  const text = await r.call("infomentor_pupils");
  expect(text).toContain("Not signed in");
  expect(r.fake.statuses.at(-1)).toBe("Not paired: log in with BankID");
  expect(await r.call("infomentor_status")).toBe("Not paired: log in with BankID.");
});

test("two overlapping login checks pair only once", async () => {
  const r = rig();
  await r.call("infomentor_login", {});
  const [a, b] = await Promise.all([
    r.call("infomentor_login_check", { wait_seconds: 10 }),
    r.call("infomentor_login_check", { wait_seconds: 10 }),
  ]);
  expect([a, b].filter((t) => t.includes("already running"))).toHaveLength(1);
  expect(r.world.callsTo("/Authentication/OAuth2/Token")).toHaveLength(1);
});

test("redirects are never followed, and the bearer reaches only the app's token endpoints", async () => {
  const first = await loggedIn();
  const later = restarted(first);
  first.world.expireAccess();
  await later.call("infomentor_news");

  expect(first.world.calls.length).toBeGreaterThan(20);
  expect(first.world.calls.every((c) => c.redirect === "manual")).toBe(true);
  const withBearer = bearerCalls(first.world.calls);
  expect(withBearer.length).toBeGreaterThan(0);
  expect(withBearer.every((c) => BEARER_PATHS.has(c.path))).toBe(true);
  expect(
    withBearer.every((c) => c.host === "api-im.infomentor.se" || c.host === "im.infomentor.se"),
  ).toBe(true);
  // The web sign-in chain that follows the bridge carries cookies at most.
  for (const path of ["/signin", "/login/consume"]) {
    for (const call of first.world.callsTo(path))
      expect(call.headers["authorization"]).toBeUndefined();
  }
  // The bridge's own request has no cookies: it is not a web request.
  for (const call of first.world.callsTo("/NA1/Authentication/sso")) {
    expect(call.headers["cookie"]).toBeUndefined();
  }
});

test("no token, cookie value or QR text reaches the log, the status line or a tool result", async () => {
  const r = rig();
  const outputs: string[] = [];
  outputs.push(await r.call("infomentor_login", { method: "url" }));
  outputs.push(await r.call("infomentor_login_check", { wait_seconds: 10 }));
  for (const name of [
    "infomentor_pupils",
    "infomentor_timetable",
    "infomentor_news",
    "infomentor_status",
  ]) {
    outputs.push(await r.call(name));
  }
  const everything = JSON.stringify([
    outputs.slice(1),
    r.fake.logs,
    r.fake.statuses,
    r.fake.notices,
  ]);
  for (const secret of [
    "ACCESS-1",
    "REFRESH-1",
    "HUBSESSION",
    "s1",
    "CODE-1",
    "GUID-1",
    "bankid.qr",
  ]) {
    expect(everything).not.toContain(secret);
  }
});

test("the tokens are in api.secrets only: one sealed value, none in state or settings", async () => {
  const r = await loggedIn();
  expect([...r.secrets.keys()]).toEqual(["pairing"]);
  expect([...r.fake.documents.keys()]).toEqual([]);
});
