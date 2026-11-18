import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Pairing } from "../mobile";
import { loggedIn, rig } from "./helpers";
import { World } from "./world";

const stored = (secrets: Map<string, string>): Pairing =>
  JSON.parse(secrets.get("pairing") ?? "null") as Pairing;

const PNG = [0x89, 0x50, 0x4e, 0x47];

test("activate registers every tool, and the status line starts at not paired", () => {
  const r = rig();
  expect(
    r.fake
      .tools()
      .map((tool) => tool.name)
      .sort(),
  ).toEqual([
    "infomentor_attachment",
    "infomentor_calendar",
    "infomentor_login",
    "infomentor_login_check",
    "infomentor_news",
    "infomentor_notifications",
    "infomentor_pupils",
    "infomentor_revoke",
    "infomentor_status",
    "infomentor_timetable",
  ]);
  expect(r.fake.logs).toEqual([{ event: "activated", fields: { tools: 10, secrets: true } }]);
});

test("BankID start: the QR image is a PNG, and every poll refreshes it", async () => {
  const r = rig();
  const text = await r.call("infomentor_login", {});
  const path = /(\S+\.png)/.exec(text)?.[1] ?? "";
  expect(path).not.toBe("");
  const first = readFileSync(path);
  expect([...first.subarray(0, 4)]).toEqual(PNG);
  expect(r.world.callsTo("/NECSadc/mbid/start").some((c) => c.url.includes("initialize=qr"))).toBe(
    true,
  );

  expect(await r.call("infomentor_login_check", { wait_seconds: 0 })).toContain("Still waiting");
  const second = readFileSync(path);
  expect(second.equals(first)).toBe(false);
  expect(await r.call("infomentor_login_check", { wait_seconds: 0 })).toContain(
    "Approve in the BankID app",
  );
});

test("BankID start by link: a bankid:/// autostart link", async () => {
  const r = rig();
  const text = await r.call("infomentor_login", { method: "url" });
  expect(text).toContain("bankid:///?autostarttoken=AUTOSTART-TOKEN&redirect=null");
  expect(text).not.toContain(".png");
  expect(
    r.world.callsTo("/NECSadc/mbid/start").some((c) => c.url.includes("initialize=bankid")),
  ).toBe(true);
});

test("after approval the SAML chain signs in and the extension pairs as the device prifly", async () => {
  const r = rig();
  await r.call("infomentor_login", {});
  const done = await r.call("infomentor_login_check", { wait_seconds: 10 });
  expect(done).toContain('paired as the device "prifly"');

  // The SAML form was posted on, with its entity-decoded fields.
  const acs = r.world.calls.find((c) => c.path === "/saml/acs");
  expect(new URLSearchParams(acs?.body).get("SAMLResponse")).toBe("a+b");

  const pairing = stored(r.secrets);
  expect(pairing.refreshToken).toBe("REFRESH-1");
  expect(pairing.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  const authorize = r.world.callsTo("/Authentication/Authentication/LoginOAuth2")[0];
  const query = new URL(authorize?.url ?? "").searchParams;
  expect(query.get("DeviceIdentifier")).toBe(pairing.deviceId);
  expect(query.get("DeviceFriendlyName")).toBe("prifly");
  expect(query.get("DevicePlatform")).toBe("Android");
  expect(query.get("client_id")).toBe("notificationapp");
  expect(query.get("redirect_uri")).toBe("InfomentorNotification://oauth2Callback");
  const exchange = r.world.callsTo("/Authentication/OAuth2/Token")[0];
  const form = new URLSearchParams(exchange?.body);
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("client_secret")).toBe("NONE");
  expect(form.get("code")).toBe("CODE-1");

  expect(r.fake.statuses.at(-1)).toBe("Signed in · paired");
  expect(await r.call("infomentor_status")).toBe("Signed in · paired.");
});

test("a cancelled BankID order ends the login with a readable message", async () => {
  const world = new World();
  world.cancelOrder = true;
  const r = rig({ world });
  await r.call("infomentor_login", {});
  expect(await r.call("infomentor_login_check", { wait_seconds: 5 })).toContain(
    "rejected, cancelled",
  );
  expect(await r.call("infomentor_login_check", { wait_seconds: 0 })).toContain(
    "No login is in progress",
  );
  expect(r.secrets.size).toBe(0);
});

test("a login redirect off the approved hosts is refused", async () => {
  const world = new World();
  world.evilStart = true;
  const r = rig({ world });
  expect(await r.call("infomentor_login", {})).toContain("outside the approved providers");
  expect(world.calls.every((c) => c.host !== "evil.example")).toBe(true);
});

test("a failed pairing keeps the web session usable and says so", async () => {
  const world = new World();
  world.discoveryOk = false;
  const r = rig({ world });
  await r.call("infomentor_login", {});
  const text = await r.call("infomentor_login_check", { wait_seconds: 10 });
  expect(text).toContain("pairing failed");
  expect(r.secrets.size).toBe(0);
  expect(await r.call("infomentor_pupils")).toContain("Anna Test");
  expect(r.fake.statuses.at(-1)).toBe("Signed in, not paired");
});

test("logging in again revokes the earlier pairing before the new one", async () => {
  const r = await loggedIn();
  const first = stored(r.secrets);
  await r.call("infomentor_login", {});
  const text = await r.call("infomentor_login_check", { wait_seconds: 10 });
  expect(text).toContain("The earlier pairing was revoked");
  const revoke = r.world.callsTo("/Authentication/OAuth2/RevokeRefreshToken")[0];
  expect(new URL(revoke?.url ?? "").searchParams.get("refreshToken")).toBe(first.refreshToken);
  const second = stored(r.secrets);
  expect(second.deviceId).not.toBe(first.deviceId);
  expect(second.refreshToken).toBe(r.world.refreshToken ?? "");
});
