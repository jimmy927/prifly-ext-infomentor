/**
 * The interactive login, in two tool calls: `start` begins a Stockholm BankID
 * order and hands the reader what they approve it with (an autostart link, a
 * QR image); `check` polls the order, refreshing the QR image on every poll,
 * and when the reader has approved, follows the SAML chain into the Hub and
 * pairs this extension as an app device. One login at a time.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PairHandle, PairSpec } from "@prifly/extension-api";
import { autostartLink, type BankIdOrder, beginBankId, finishBankId, pollBankId } from "./bankid";
import { CookieJar, type FetchLike } from "./http";
import type { MobileAuth, PairingStore } from "./mobile";
import { qrPng } from "./qr";
import { InfoMentorError } from "./saml";
import { describeError } from "./scrub";
import type { HubSession } from "./session";

type Dialog = {
  handle: PairHandle;
  /** The reader cancelled it, or a new login replaced it. */
  cancelled: boolean;
  done: Promise<string>;
};

const WAITING = "Waiting for the BankID app";
/** BankID QR orders run out after about 30 s; this keeps the dialog going about 3 minutes. */
const MAX_DIALOG_ORDERS = 6;
const DIALOG_CANCELLED = "Not done: you cancelled the BankID login.";

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
    return this.attempt !== null || this.dialog !== null;
  }

  /** The login running in prifly's pairing dialog, if one is. */
  private dialog: Dialog | null = null;

  /**
   * The whole login in prifly's own pairing dialog: the live QR is drawn in
   * the window (no file), renewed on every poll, a new order is made when one
   * expires or is cancelled in the app, and an approval signs in and pairs
   * without the session doing anything. Resolves once the dialog is open.
   */
  async startDialog(pair: (spec: PairSpec) => PairHandle, sessionId: string): Promise<string> {
    this.closeDialog();
    this.attempt = null;
    const first = await this.newAttempt();
    const handle = pair({
      sessionId,
      title: "Log in to InfoMentor with BankID",
      description:
        'prifly signs in as your guardian account and pairs itself as the device "prifly", so later reads need no BankID.',
      steps: [
        "Open the BankID app on your phone.",
        "Tap Scan QR code and point the camera at this code.",
        "Approve with your security code.",
      ],
      hint: "The code changes every second; a new one is made by itself if it runs out.",
      askPhone: false,
    });
    handle.update({ qr: first.order.qrData, status: WAITING });
    const dialog: Dialog = { handle, cancelled: false, done: Promise.resolve("") };
    void handle.closed.then((how) => {
      if (how === "cancelled") dialog.cancelled = true;
    });
    dialog.done = this.runDialog(dialog, first);
    this.dialog = dialog;
    return [
      "A BankID QR code is open in prifly's window, over this session.",
      "The reader scans it with the BankID app and approves; the code renews itself, a new order is made if one runs out, and the sign-in and pairing finish on their own.",
      "Call `infomentor_login_check` to wait for the result: it answers as soon as the login ends.",
    ].join(" ");
  }

  /** Resolves when the dialog's login ends, with its answer; null when none runs. */
  get dialogDone(): Promise<string> | null {
    return this.dialog?.done ?? null;
  }

  /** Closes a dialog this manager opened, as when a new login replaces it. */
  private closeDialog(): void {
    const dialog = this.dialog;
    this.dialog = null;
    if (dialog === null) return;
    dialog.cancelled = true;
    dialog.handle.close();
  }

  private async newAttempt(): Promise<Attempt> {
    const jar = new CookieJar();
    const order = await beginBankId(this.deps.fetcher, jar, "qr");
    if (order.qrData === null) {
      throw new InfoMentorError("The BankID start gave no QR code; values withheld.");
    }
    return { jar, order, png: "", state: "PENDING" };
  }

  /** Polls in the background until approved, given up or cancelled; never rejects. */
  private async runDialog(dialog: Dialog, first: Attempt): Promise<string> {
    try {
      return await this.dialogLoop(dialog, first);
    } catch (error) {
      const why =
        error instanceof InfoMentorError
          ? error.message
          : `${describeError(error).name}: ${describeError(error).message}`;
      if (!dialog.cancelled) dialog.handle.update({ qr: null, status: `Login failed: ${why}` });
      return `Not done: the BankID login failed (${why}).`;
    }
  }

  private async dialogLoop(dialog: Dialog, first: Attempt): Promise<string> {
    let attempt = first;
    let orders = 1;
    for (;;) {
      if (dialog.cancelled) return DIALOG_CANCELLED;
      const status = await this.pollOrder(attempt);
      if (dialog.cancelled) return DIALOG_CANCELLED;
      if (status === null) {
        if (orders >= MAX_DIALOG_ORDERS) return this.giveUp(dialog, orders);
        attempt = await this.renewOrder(dialog);
        orders += 1;
        continue;
      }
      if (status.state === "OK") return await this.finishDialog(dialog, attempt);
      this.showPoll(dialog, attempt, status);
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  /** One poll; null when the order ran out or was cancelled in the app. */
  private async pollOrder(
    attempt: Attempt,
  ): Promise<Awaited<ReturnType<typeof pollBankId>> | null> {
    try {
      return await pollBankId(this.deps.fetcher, attempt.jar, attempt.order);
    } catch (error) {
      if (error instanceof InfoMentorError && error.message.includes("rejected")) return null;
      throw error;
    }
  }

  private giveUp(dialog: Dialog, orders: number): string {
    dialog.handle.update({ qr: null, status: "No approval in time. Close this and try again." });
    return `Not done: no BankID approval after ${orders} codes; the dialog says so. Call \`infomentor_login\` to try again.`;
  }

  private async renewOrder(dialog: Dialog): Promise<Attempt> {
    dialog.handle.update({ qr: null, status: "The code ran out; making a new one" });
    const attempt = await this.newAttempt();
    dialog.handle.update({ qr: attempt.order.qrData, status: WAITING });
    return attempt;
  }

  private showPoll(
    dialog: Dialog,
    attempt: Attempt,
    status: { state: string; qrData: string | null },
  ): void {
    const update: { status: string; qr?: string } = {
      status: status.state === "USER_SIGN" ? "Approve in the BankID app" : WAITING,
    };
    if (status.qrData !== null) {
      attempt.order = { ...attempt.order, qrData: status.qrData };
      update.qr = status.qrData;
    }
    dialog.handle.update(update);
  }

  private async finishDialog(dialog: Dialog, attempt: Attempt): Promise<string> {
    dialog.handle.update({ qr: null, status: "Approved; signing in to InfoMentor" });
    const text = await this.complete(attempt);
    dialog.handle.update(
      text.includes("paired as the device")
        ? { linked: true, status: 'Signed in and paired as "prifly"' }
        : { status: "Signed in, but the pairing failed" },
    );
    return text;
  }

  /** Waits up to `waitSeconds` for the dialog's login to end. */
  private async waitDialog(dialog: Dialog, waitSeconds: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitSeconds * 1000);
    });
    const text = await Promise.race([dialog.done, timeout]);
    clearTimeout(timer);
    if (text === null) {
      return "Still waiting: the BankID QR is open in prifly's window. Call `infomentor_login_check` again.";
    }
    if (this.dialog === dialog) this.dialog = null;
    return text;
  }

  async start(method: "qr" | "url", folder: string): Promise<string> {
    this.closeDialog();
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
    // The dialog's login polls by itself; a check only waits for it, so any number may.
    if (this.dialog !== null) return await this.waitDialog(this.dialog, waitSeconds);
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
