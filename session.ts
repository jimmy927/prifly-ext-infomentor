/**
 * The extension's one Hub session: cookies in memory, renewed from the pairing
 * when they are missing or the Hub says they ended. Every Hub call goes
 * through `run`, one at a time: the Hub keeps "which pupil is selected" for
 * the whole session, so two calls at once would read each other's pupil.
 */

import type { CookieJar } from "./http";
import type { MobileAuth } from "./mobile";
import type { PupilState } from "./pupils";
import { LoginRequiredError, NotPairedError, PairingRejectedError } from "./saml";

/** What the status line says about the connection. */
export type Standing = "not-paired" | "paired" | "signed-in" | "rejected";

/** One at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class HubSession {
  private jar: CookieJar | null = null;
  private readonly lock = new Mutex();
  /** The pupils of the current cookies; reset whenever they change. */
  pupils: PupilState | null = null;

  private readonly mobile: MobileAuth;
  private readonly onStanding: (standing: Standing) => void;

  constructor(mobile: MobileAuth, onStanding: (standing: Standing) => void) {
    this.mobile = mobile;
    this.onStanding = onStanding;
  }

  get signedIn(): boolean {
    return this.jar !== null;
  }

  /** Uses the cookies of a fresh BankID login. */
  adopt(jar: CookieJar): Promise<void> {
    return this.lock.run(async () => {
      this.jar = jar;
      this.pupils = null;
      this.onStanding("signed-in");
    });
  }

  /** Forgets the cookies (the pairing was revoked or lost). */
  drop(standing: Standing): Promise<void> {
    return this.lock.run(async () => {
      this.jar = null;
      this.pupils = null;
      this.onStanding(standing);
    });
  }

  private async renew(): Promise<CookieJar> {
    this.jar = null;
    this.pupils = null;
    try {
      this.jar = await this.mobile.renewHub();
    } catch (error) {
      if (error instanceof NotPairedError) this.onStanding("not-paired");
      else if (error instanceof PairingRejectedError) this.onStanding("rejected");
      throw error;
    }
    this.onStanding("signed-in");
    return this.jar;
  }

  /**
   * Runs `operation` with the session. Missing cookies are renewed first; a
   * Hub that says the session ended gets one renewal and one retry.
   */
  run<T>(operation: (jar: CookieJar) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const jar = this.jar ?? (await this.renew());
      try {
        return await operation(jar);
      } catch (error) {
        if (!(error instanceof LoginRequiredError)) throw error;
        return await operation(await this.renew());
      }
    });
  }
}
