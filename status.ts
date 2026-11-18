/** The one line the extension says about itself (`api.status`): signed in / paired / not paired. */

import type { ExtensionApi } from "@prifly/extension-api";
import type { PairingStore } from "./mobile";
import type { HubSession, Standing } from "./session";

export function standingText(paired: boolean, signedIn: boolean, rejected: boolean): string {
  if (rejected) return "Pairing rejected by InfoMentor: log in with BankID again";
  if (!paired) return signedIn ? "Signed in, not paired" : "Not paired: log in with BankID";
  return signedIn ? "Signed in · paired" : "Paired · renews on the next read";
}

export class StatusKeeper {
  private rejected = false;
  session: HubSession | null = null;

  private readonly store: PairingStore;
  private readonly api: () => ExtensionApi | null;

  constructor(store: PairingStore, api: () => ExtensionApi | null) {
    this.store = store;
    this.api = api;
  }

  /** Called by the session whenever its standing changes. */
  note = (standing: Standing): void => {
    this.rejected = standing === "rejected";
    void this.refresh();
  };

  async text(): Promise<string> {
    const paired = (await this.store.load()) !== null;
    return standingText(paired, this.session?.signedIn ?? false, this.rejected);
  }

  async refresh(): Promise<void> {
    const line = await this.text().catch(() => "");
    this.api()?.status?.(line);
  }
}
