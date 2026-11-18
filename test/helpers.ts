/** A fake prifly api with `api.secrets`, the extension activated over a fake InfoMentor. */

import type { ExtensionApi } from "@prifly/extension-api";
import { activateWith } from "../index";
import { type FakeApi, fakeApi } from "./fake-api";
import { World } from "./world";

export type Rig = {
  fake: FakeApi;
  world: World;
  /** What `api.secrets` holds right now. */
  secrets: Map<string, string>;
  stop: () => void;
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
};

export function rig(
  options: {
    confirm?: boolean;
    world?: World;
    secrets?: Map<string, string>;
    folder?: string;
  } = {},
): Rig {
  const fake = fakeApi({
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
  });
  const secrets = options.secrets ?? new Map<string, string>();
  const api: ExtensionApi = {
    ...fake.api,
    features: [...(fake.api.features ?? []), "secrets"],
    secrets: {
      get: async (key) => secrets.get(key) ?? null,
      set: async (key, value) => {
        if (value === null) secrets.delete(key);
        else secrets.set(key, value);
      },
      keys: async (prefix = "") =>
        [...secrets.keys()].filter((key) => key.startsWith(prefix)).sort(),
    },
  };
  const world = options.world ?? new World();
  const stop = activateWith(api, world.fetcher, { sleep: async () => undefined });
  return {
    fake,
    world,
    secrets,
    stop,
    call: (name, args = {}) => fake.callTool(name, args),
  };
}

/** Logs in through the two login tools with the fake BankID approving at once. */
export async function loggedIn(
  options: { confirm?: boolean; world?: World; folder?: string } = {},
): Promise<Rig> {
  const r = rig(options);
  await r.call("infomentor_login", { method: "qr" });
  const text = await r.call("infomentor_login_check", { wait_seconds: 10 });
  if (!text.includes("paired")) throw new Error(`login failed in the test rig: ${text}`);
  return r;
}
