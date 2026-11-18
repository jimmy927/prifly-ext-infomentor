/**
 * The interactive login, in two tool calls: `start` begins a Stockholm BankID
 * order and hands the reader what they approve it with (an autostart link, a
 * QR image); `check` polls the order, refreshing the QR image on every poll,
 * and when the reader has approved, follows the SAML chain into the Hub and
 * pairs this extension as an app device. One login at a time.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autostartLink, type BankIdOrder, beginBankId, finishBankId, pollBankId } from "./bankid";
import { CookieJar, type FetchLike } from "./http";
import type { MobileAuth, PairingStore } from "./mobile";
import { qrPng } from "./qr";
import { InfoMentorError } from "./saml";
import type { HubSession } from "./session";

type Attempt = {
  jar: CookieJar;
  order: BankIdOrder;
  /** Where the QR image of this login is kept up to date. */
  png: string;
  state: "PENDING" | "USER_SIGN";
};

export type LoginDeps = {
  fetcher: FetchLike;
  mobile: MobileAuth;
  session: HubSession;
  store: PairingStore;
  sleep?: (ms: number) => Promise<void>;
};

const POLL_INTERVAL_MS = 1000;
export const MAX_WAIT_SECONDS = 60;
export const DEFAULT_WAIT_SECONDS = 20;

export class LoginManager {
  private attempt: Attempt | null = null;
  private checking = false;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly deps: LoginDeps;

  constructor(deps: LoginDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get pending(): boolean {
    return this.attempt !== null;
  }

  async start(method: "qr" | "url", folder: string): Promise<string> {
    this.attempt = null;
    const jar = new CookieJar();
    const order = await beginBankId(this.deps.fetcher, jar, method);
    await mkdir(folder, { recursive: true });
    const png = join(folder, `infomentor-bankid-${Date.now()}.png`);
    this.attempt = { jar, order, png, state: "PENDING" };
    if (order.qrData !== null) await writeFile(png, qrPng(order.qrData));
    return this.instructions(this.attempt);
  }

  private instructions(attempt: Attempt): string {
    const lines = ["# InfoMentor login: approve with BankID", ""];
    if (attempt.order.autostartToken !== null) {
      lines.push(
        `- Open this link on the phone that has BankID: ${autostartLink(attempt.order.autostartToken)}`,
      );
    }
    if (attempt.order.qrData !== null) {
      lines.push(
        `- Or scan the QR image with the BankID app: ${attempt.png}`,
        "  It is animated: the file is rewritten on every poll, so show the newest copy.",
      );
    }
    lines.push(
      "",
      "Then call `infomentor_login_check` right away. The order expires after about 30 seconds if it is not approved.",
      "The link and the QR are one-time and sensitive: do not share them.",
    );
    return lines.join("\n");
  }

  /** Polls for up to `waitSeconds`; finishes the login when the reader has approved. */
  async check(waitSeconds: number): Promise<string> {
    // Two overlapping checks could both see OK and pair twice.
    if (this.checking) return "A login check is already running; wait for its answer.";
    this.checking = true;
    try {
      return await this.poll(waitSeconds);
    } finally {
      this.checking = false;
    }
  }

  private async poll(waitSeconds: number): Promise<string> {
    const attempt = this.attempt;
    if (attempt === null) {
      return "No login is in progress. Call `infomentor_login` to start one.";
    }
    const deadline = Date.now() + waitSeconds * 1000;
    try {
      for (;;) {
        const status = await pollBankId(this.deps.fetcher, attempt.jar, attempt.order);
        if (status.state === "OK") return await this.complete(attempt);
        attempt.state = status.state;
        if (status.qrData !== null) {
          attempt.order = { ...attempt.order, qrData: status.qrData };
          await writeFile(attempt.png, qrPng(status.qrData));
        }
        if (Date.now() >= deadline) break;
        await this.sleep(POLL_INTERVAL_MS);
      }
    } catch (error) {
      this.attempt = null;
      throw error;
    }
    const where =
      attempt.state === "USER_SIGN"
        ? "Approve in the BankID app (enter your code)."
        : "Waiting for the BankID app.";
    return `Still waiting: ${where} Call \`infomentor_login_check\` again.${
      attempt.order.qrData === null ? "" : ` The QR image ${attempt.png} was refreshed.`
    }`;
  }

  private async complete(attempt: Attempt): Promise<string> {
    this.attempt = null;
    await finishBankId(this.deps.fetcher, attempt.jar, attempt.order);
    // The new session is good for this process whatever happens to the pairing.
    await this.deps.session.adopt(attempt.jar);
    let replaced = "";
    if ((await this.deps.store.load()) !== null) {
      try {
        await this.deps.mobile.revoke();
        replaced = " The earlier pairing was revoked.";
      } catch {
        replaced = " An earlier pairing could not be revoked and is replaced here only.";
      }
    }
    try {
      await this.deps.mobile.pair(attempt.jar);
    } catch (error) {
      const why = error instanceof InfoMentorError ? error.message : "an unexpected error";
      return `Signed in to InfoMentor, but pairing failed (${why}). Reads work until this session ends; call \`infomentor_login\` again to pair.${replaced}`;
    }
    await this.deps.session.adopt(attempt.jar);
    return `Signed in to InfoMentor and paired as the device "prifly". Later reads renew themselves without BankID.${replaced}`;
  }
}
