import { expect, test } from "bun:test";
import { rig } from "./helpers";
import { World } from "./world";

const qrs = (updates: { qr?: string | null }[]): (string | null | undefined)[] =>
  updates.filter((u) => "qr" in u).map((u) => u.qr);

test("with prifly's pairing dialog the QR is drawn live, no file, and approval pairs by itself", async () => {
  const r = rig({ pair: true });
  const text = await r.call("infomentor_login", {});
  expect(text).toContain("open in prifly's window");
  expect(text).not.toContain(".png");
  expect(r.dialogs).toHaveLength(1);
  const dialog = r.dialogs[0];
  expect(dialog?.spec.sessionId).toBe("fake-session");
  expect(dialog?.spec.askPhone).toBe(false);

  const done = await r.call("infomentor_login_check", { wait_seconds: 10 });
  expect(done).toContain('paired as the device "prifly"');
  // The first QR, then one per poll that gave a new one.
  expect(qrs(dialog?.updates ?? [])).toEqual(["bankid.qr.0", "bankid.qr.1", "bankid.qr.2", null]);
  expect(dialog?.updates.at(-1)).toEqual({
    linked: true,
    status: 'Signed in and paired as "prifly"',
  });
  expect(r.secrets.has("pairing")).toBe(true);
  // The status line moves without another tool call.
  await Promise.resolve();
  expect(r.fake.statuses.at(-1)).toBe("Signed in · paired");
  expect(await r.call("infomentor_login_check", { wait_seconds: 0 })).toContain(
    "No login is in progress",
  );
});

test("an order that runs out is replaced in the same dialog, a few times at most", async () => {
  const world = new World();
  world.cancelOrder = true;
  const r = rig({ world, pair: true });
  await r.call("infomentor_login", {});
  const text = await r.call("infomentor_login_check", { wait_seconds: 10 });
  expect(text).toContain("no BankID approval after 6 codes");
  expect(
    world.callsTo("/NECSadc/mbid/start").filter((c) => c.url.includes("initialize=qr")),
  ).toHaveLength(6);
  expect(r.dialogs).toHaveLength(1);
  expect(r.dialogs[0]?.updates.some((u) => u.status === "The code ran out; making a new one")).toBe(
    true,
  );
  expect(r.secrets.size).toBe(0);
});

test("a check while the reader has not scanned says still waiting; Cancel ends the login", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const world = new World();
  world.pendingPolls = 1000;
  const r = rig({ world, pair: true, sleep: () => hold });
  await r.call("infomentor_login", {});
  expect(await r.call("infomentor_login_check", { wait_seconds: 0 })).toContain("Still waiting");
  r.dialogs[0]?.cancel();
  release();
  expect(await r.call("infomentor_login_check", { wait_seconds: 5 })).toBe(
    "Not done: you cancelled the BankID login.",
  );
  expect(r.secrets.size).toBe(0);
});

test("a new login closes the dialog of the one before", async () => {
  const world = new World();
  world.pendingPolls = 1000;
  const r = rig({ world, pair: true, sleep: () => new Promise(() => undefined) });
  await r.call("infomentor_login", {});
  await r.call("infomentor_login", {});
  expect(r.dialogs.map((d) => d.closedBy)).toEqual(["closed", null]);
});

test("the link method still answers with a bankid:/// link, not a dialog", async () => {
  const r = rig({ pair: true });
  const text = await r.call("infomentor_login", { method: "url" });
  expect(text).toContain("bankid:///?autostarttoken=");
  expect(r.dialogs).toHaveLength(0);
});
