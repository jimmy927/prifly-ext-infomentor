/**
 * The tools about the connection itself: log in with BankID, check on a login,
 * say how things stand, and revoke the pairing (the only write, behind a card).
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { sessionFolder } from "./folder";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./login";
import { InfoMentorError } from "./saml";
import { optionalInt, optionalString, type Services, tool } from "./tools-kit";

export const CANCELLED = "Not done: you cancelled. The pairing is unchanged.";

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

export function authTools(services: Services | null): ExtensionTool[] {
  return [
    tool(
      services,
      {
        name: "infomentor_login",
        description:
          "Starts a Stockholm BankID login to InfoMentor (guardian / vardnadshavare). With qr, prifly's window shows a live BankID QR code in a dialog over this session that renews itself and finishes the sign-in on its own once the reader approves; on an older prifly it returns a QR image path instead. With url, an autostart link for the phone. Then call infomentor_login_check for the result. Needed once; afterwards the extension renews itself without BankID.",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              enum: ["qr", "url"],
              description:
                "qr (default): a live QR code to scan from the screen. url: autostart link to open on the phone that has BankID.",
            },
          },
          additionalProperties: false,
        },
      },
      async (s, args, ctx) => {
        const method = optionalString(args, "method") ?? "qr";
        if (method !== "qr" && method !== "url")
          throw new InfoMentorError("method must be qr or url.");
        const api = s.api();
        const pair = api?.pair;
        if (method === "qr" && pair !== undefined && api?.features?.includes("pair-dialog")) {
          const text = await s.login.startDialog((spec) => pair(spec), ctx.session);
          void s.login.dialogDone?.then(() => s.refreshStatus());
          return text;
        }
        return await s.login.start(method, await sessionFolder(api, ctx));
      },
    ),
    tool(
      services,
      {
        name: "infomentor_login_check",
        description:
          "Follows up infomentor_login: waits up to wait_seconds for the login (with a QR image instead of the dialog, it polls the order and refreshes the image). When the reader has approved, completes the sign-in and pairs this extension as an InfoMentor app device named prifly. Call again while it says still waiting.",
        inputSchema: {
          type: "object",
          properties: {
            wait_seconds: {
              type: "integer",
              description: `How long to wait for the approval (0-${MAX_WAIT_SECONDS}). Default ${DEFAULT_WAIT_SECONDS}.`,
            },
          },
          additionalProperties: false,
        },
      },
      async (s, args) => {
        const wait = optionalInt(args, "wait_seconds", DEFAULT_WAIT_SECONDS, 0, MAX_WAIT_SECONDS);
        const text = await s.login.check(wait);
        await s.refreshStatus();
        return text;
      },
    ),
    tool(
      services,
      {
        name: "infomentor_status",
        description: "Says whether InfoMentor is paired and signed in. Contacts no one.",
        inputSchema: NO_ARGS,
      },
      async (s) => `${await s.standing()}.`,
    ),
    revokeTool(services),
  ];
}

function revokeTool(services: Services | null): ExtensionTool {
  return tool(
    services,
    {
      name: "infomentor_revoke",
      description:
        "Revokes the prifly pairing at InfoMentor and forgets its tokens here. The reader confirms on a card first. Afterwards a new BankID login is needed to read again.",
      inputSchema: NO_ARGS,
    },
    async (s) => {
      const api = s.api();
      if (api?.confirm === undefined) {
        return "Not done: this prifly cannot ask you first. Update prifly.";
      }
      if ((await s.store.load()) === null) return "InfoMentor is not paired; nothing to revoke.";
      const yes = await api.confirm({
        title: "Revoke the InfoMentor pairing",
        summary: 'Revoke the "prifly" device at InfoMentor and forget its tokens',
        details:
          "GET https://im.infomentor.se/Authentication/OAuth2/RevokeRefreshToken?refreshToken=...\nAfterwards prifly can no longer read InfoMentor until you log in with BankID again.",
      });
      if (yes !== true) return CANCELLED;
      const result = await s.mobile.revoke();
      await s.session.drop("not-paired");
      await s.refreshStatus();
      return result === "revoked"
        ? "Revoked: InfoMentor rejects the old pairing and its tokens are forgotten here."
        : "The pairing was already rejected by InfoMentor; its tokens are forgotten here.";
    },
  );
}
