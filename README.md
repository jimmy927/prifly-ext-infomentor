# prifly-ext-infomentor

A prifly extension that lets any session read your children's InfoMentor Hub as
a Stockholm stad guardian (vårdnadshavare): timetable, news, calendar,
notifications and news attachments. Read-only: it never writes to a childcare
schedule or any school record.

## Install

```sh
git clone <this repository> ~/src/prifly-ext-infomentor   # or use the checkout you have
cd ~/src/prifly-ext-infomentor && bun install
ln -s ~/src/prifly-ext-infomentor ~/.local/share/prifly/extensions/infomentor
```

Then enable **InfoMentor** in prifly's Extensions dialog. A linked extension is
your own checkout: prifly never updates it. `mcp__prifly__extension_status`
shows which commit is running.

## Log in once

Ask a session: "log in to InfoMentor". It calls `infomentor_login`, which
starts Stockholm stad's BankID and returns an animated QR image (a PNG path) and,
with `method: "url"`, a `bankid:///?autostarttoken=…` link to open on the phone
that has BankID. Approve in the BankID app; the session then calls
`infomentor_login_check`, which completes the sign-in and pairs the extension as
an InfoMentor Hub app device named `prifly` with its own random UUID.

Afterwards no BankID is needed: the refresh token (kept in `api.secrets`, sealed by
prifly) renews the access token (10 minutes) and from it a fresh Hub web
session, on demand. `infomentor_revoke` ends the pairing.

## Tools

| Tool                       | What it does                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- |
| `infomentor_login`         | Starts a BankID login; returns the QR image path and/or the autostart link.      |
| `infomentor_login_check`   | Polls the BankID order (refreshing the QR), then signs in and pairs.             |
| `infomentor_status`        | Says whether it is paired and signed in; contacts no one.                        |
| `infomentor_pupils`        | Lists the linked children and their pupil ids.                                   |
| `infomentor_timetable`     | One week of lessons per child.                                                   |
| `infomentor_news`          | School news, newest first, with attachment ids.                                  |
| `infomentor_calendar`      | Calendar events for a date range (at most 366 days).                             |
| `infomentor_notifications` | Notifications, newest first (reading does not mark them seen).                   |
| `infomentor_attachment`    | Downloads one news attachment to a file and returns its path.                    |
| `infomentor_revoke`        | Revokes the pairing at InfoMentor and forgets the tokens (asks on a card first). |

Every read tool takes an optional `pupil` (a name or part of one, or the id);
leave it out for all linked children. Output is Markdown in Europe/Stockholm
time. What the school wrote is quoted as data, and each tool says so.

## How it stays safe

- Tokens live only in `api.secrets`; never in prifly's vault, a file or a log.
  Hub cookies live in memory only.
- Requests that carry a token use `redirect: "manual"`; the web sign-in chain that
  follows the token exchange never receives a bearer header; every sign-in hop
  must be https on an InfoMentor or Stockholm stad host.
- A rotated refresh token is persisted before anything else can fail.
- Hub's "selected pupil" is shared server state, so Hub calls run one at a time
  and the original selection is put back after each read.

## Develop

`bun test`, `bun run typecheck`, `bun run check`. Tests run against a fake
InfoMentor behind an injected `fetch`; nothing touches the network.

## Credit

The wire protocol was re-implemented in TypeScript from the research and
implementation in [infomentor-mcp](https://github.com/wicol/infomentor-mcp),
which is MIT licensed:

```
MIT License

Copyright (c) 2026 Wictor Olseryd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

No code of infomentor-mcp is included or run.
