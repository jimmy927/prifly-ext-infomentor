/** A fake prifly api with `api.secrets`, the extension activated over a fake InfoMentor. */

import type { ExtensionApi, PairHandle, PairSpec, PairUpdate } from "@prifly/extension-api";
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
  /** Every pairing dialog `api.pair` opened; empty when the rig has no `pair`. */
  dialogs: FakeDialog[];
};

/** A pairing dialog as prifly would draw it: its spec, every update, and the reader's Cancel. */
export type FakeDialog = {
  spec: PairSpec;
  updates: PairUpdate[];
  closedBy: "cancelled" | "closed" | null;
  /** The reader presses Cancel. */
  cancel: () => void;
};

function fakePair(dialogs: FakeDialog[]): (spec: PairSpec) => PairHandle {
  return (spec) => {
    let end: (how: "cancelled" | "closed") => void = () => undefined;
    const closed = new Promise<"cancelled" | "closed">((resolve) => {
      end = resolve;
    });
    const dialog: FakeDialog = {
      spec,
      updates: [],
      closedBy: null,
      cancel: () => {
        if (dialog.closedBy !== null) return;
        dialog.closedBy = "cancelled";
        end("cancelled");
      },
    };
    dialogs.push(dialog);
    return {
      update: (next) => void dialog.updates.push(next),
      close: () => {
        if (dialog.closedBy !== null) return;
        dialog.closedBy = "closed";
        end("closed");
      },
      phones: (async function* () {})(),
      closed,
    };
  };
}

export function rig(
  options: {
    confirm?: boolean;
    world?: World;
    secrets?: Map<string, string>;
    folder?: string;
    /** Give the api prifly's pairing dialog (`api.pair`, feature "pair-dialog"). */
    pair?: boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Rig {
  const dialogs: FakeDialog[] = [];
  const fake = fakeApi({
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
  });
  const secrets = options.secrets ?? new Map<string, string>();
  const api: ExtensionApi = {
    ...fake.api,
    features: [
      ...(fake.api.features ?? []),
      "secrets",
      ...(options.pair === true ? ["pair-dialog"] : []),
    ],
    ...(options.pair === true ? { pair: fakePair(dialogs) } : {}),
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
  const stop = activateWith(api, world.fetcher, {
    sleep: options.sleep ?? (async () => undefined),
  });
  return {
    fake,
    world,
    secrets,
    stop,
    call: (name, args = {}) => fake.callTool(name, args),
    dialogs,
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
