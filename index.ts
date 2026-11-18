/**
 * The InfoMentor extension: what prifly imports. `activate` registers the
 * tools; the tokens live in `api.secrets` (sealed by prifly), the Hub cookies
 * in memory only. Nothing secret is ever logged.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import type { FetchLike } from "./http";
import { Hub } from "./hub";
import { LoginManager } from "./login";
import { MobileAuth, type Pairing, type PairingStore } from "./mobile";
import { HubSession } from "./session";
import { StatusKeeper } from "./status";
import { authTools } from "./tools-auth";
import type { Services } from "./tools-kit";
import { readTools } from "./tools-read";

const PAIRING_KEY = "pairing";

function isPairing(value: unknown): value is Pairing {
  const p = value as Partial<Pairing> | null;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.deviceId === "string" &&
    typeof p.refreshToken === "string" &&
    (p.accessToken === null || typeof p.accessToken === "string") &&
    (p.accessExpiresAt === null || typeof p.accessExpiresAt === "number")
  );
}

/** The pairing in `api.secrets`: one sealed value, replaced whole on every rotation. */
export function secretPairingStore(api: ExtensionApi): PairingStore | null {
  const secrets = api.secrets;
  if (secrets === undefined) return null;
  return {
    async load() {
      const raw = await secrets.get(PAIRING_KEY);
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isPairing(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    save: (pairing) => secrets.set(PAIRING_KEY, JSON.stringify(pairing)),
    clear: () => secrets.set(PAIRING_KEY, null),
  };
}

let current: ExtensionApi | null = null;

/** `activate` with an injected `fetch`: what the tests use. */
export function activateWith(
  given: ExtensionApi,
  fetcher: FetchLike,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): () => void {
  current = given;
  const store = secretPairingStore(given);
  let services: Services | null = null;
  if (store !== null) {
    const status = new StatusKeeper(store, () => current);
    const mobile = new MobileAuth(fetcher, store);
    const session = new HubSession(mobile, status.note);
    status.session = session;
    services = {
      api: () => current,
      hub: new Hub(fetcher, session),
      login: new LoginManager({
        fetcher,
        mobile,
        session,
        store,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      }),
      mobile,
      session,
      store,
      refreshStatus: () => status.refresh(),
      standing: () => status.text(),
    };
    void status.refresh();
  }
  // Absent on an older prifly: optional, like every part added after the first version.
  const tools = [...authTools(services), ...readTools(services)];
  given.tools?.register(tools);
  given.log("activated", { tools: tools.length, secrets: store !== null });
  return () => {
    current = null;
  };
}

export function activate(given: ExtensionApi): () => void {
  return activateWith(given, (url, init) => fetch(url, init));
}
