import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@prifly/extension-api";
import { isWindowsPath, sessionFolder } from "../folder";
import { scrubMessage } from "../scrub";
import { loggedIn, rig } from "./helpers";
import { NEWS, World } from "./world";

/** A scratchpad the host cannot create: a folder under a plain file (ENOTDIR). */
function unwritableScratchpad(): string {
  const dir = mkdtempSync(join(tmpdir(), "im-unwritable-"));
  const file = join(dir, "not-a-folder");
  writeFileSync(file, "");
  return join(file, "claude-1000", "scratchpad");
}

function context(scratchpad: string): ExtensionToolContext {
  return {
    session: "fake-session",
    pick: async () => null,
    signal: new AbortController().signal,
    scratchpad,
  };
}

async function callWith(
  r: ReturnType<typeof rig>,
  name: string,
  args: Record<string, unknown>,
  scratchpad: string,
): Promise<string> {
  const tool = r.fake.tools().find((each) => each.name === name);
  if (tool === undefined) throw new Error(`No tool ${name}`);
  return await tool.call(args, context(scratchpad));
}

test("a scratchpad the host cannot write: the QR image lands in the extension's folder and exists", async () => {
  const folder = mkdtempSync(join(tmpdir(), "im-ext-folder-"));
  const r = rig({ folder });
  const text = await callWith(r, "infomentor_login", {}, unwritableScratchpad());
  const path = /(\S+\.png)/.exec(text)?.[1] ?? "";
  expect(path.startsWith(join(folder, "files"))).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(r.fake.logs.some((l) => l.event === "tool_failed")).toBe(false);
});

test("a scratchpad that works is still used first", async () => {
  const scratchpad = mkdtempSync(join(tmpdir(), "im-scratch-"));
  const r = rig({ folder: mkdtempSync(join(tmpdir(), "im-ext-folder-")) });
  const text = await callWith(r, "infomentor_login", {}, scratchpad);
  const path = /(\S+\.png)/.exec(text)?.[1] ?? "";
  expect(path.startsWith(join(scratchpad, "infomentor"))).toBe(true);
  expect(existsSync(path)).toBe(true);
});

test("an unexpected error is logged with its scrubbed message, and the answer carries it", async () => {
  const world = new World();
  world.fetcher = async () => {
    throw new TypeError(
      "Unable to connect to https://im.infomentor.se/start?autostarttoken=AAAA1111BBBB2222CCCC3333DDDD4444&x=1 with refreshToken: 0123456789abcdef0123456789abcdef",
    );
  };
  const r = rig({ world });
  const text = await r.call("infomentor_login", {});
  expect(text).toStartWith(
    "Not done: InfoMentor failed unexpectedly (TypeError: Unable to connect to",
  );
  expect(text).toContain("https://im.infomentor.se/start?[redacted]");
  const logged = r.fake.logs.find((l) => l.event === "tool_failed");
  expect(logged?.fields?.["tool"]).toBe("infomentor_login");
  expect(logged?.fields?.["name"]).toBe("TypeError");
  expect(String(logged?.fields?.["message"])).toContain("Unable to connect to");
  for (const secret of ["AAAA1111", "0123456789abcdef", "x=1"]) {
    expect(text).not.toContain(secret);
    expect(JSON.stringify(r.fake.logs)).not.toContain(secret);
  }
});

test("an fs error keeps its code and path in the answer", async () => {
  const error = Object.assign(
    new Error("EACCES: permission denied, mkdir '/tmp/claude-1000/scratchpad'"),
    { code: "EACCES" },
  );
  expect(scrubMessage(error.message)).toBe(error.message);
});

test("scrubbing drops query strings, secret pairs and long token-like runs", () => {
  expect(scrubMessage("GET http://a.example/p?q=secret#frag failed")).toBe(
    "GET http://a.example/p?[redacted] failed",
  );
  expect(scrubMessage("cookie=abc123 and Authorization: Bearer xyz")).not.toContain("abc123");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
  expect(scrubMessage(`bad ${jwt}`)).not.toContain("eyJzdWIi");
});

test("a scratchpad the host cannot write: an attachment is saved in the extension's folder", async () => {
  const folder = mkdtempSync(join(tmpdir(), "im-ext-folder-"));
  const r = await loggedIn({ folder });
  r.world.news["101"] = [NEWS];
  const text = await callWith(
    r,
    "infomentor_attachment",
    { news_id: "55", attachment_id: "777", pupil: "anna" },
    unwritableScratchpad(),
  );
  const path = / to (\S+Lista\.pdf)$/.exec(text)?.[1] ?? "";
  expect(path.startsWith(join(folder, "files"))).toBe(true);
  expect(existsSync(path)).toBe(true);
});

test("on win32 a posix-style scratchpad is skipped, other hosts use it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "im-ext-folder-"));
  const api = rig({ folder }).fake.api;
  const posix = join(mkdtempSync(join(tmpdir(), "im-posix-")), "x");
  expect(await sessionFolder(api, context(posix), "win32")).toBe(join(folder, "files"));
  expect(existsSync(posix)).toBe(false);
  expect(await sessionFolder(api, context(posix), "linux")).toBe(join(posix, "infomentor"));
});

test("Windows paths (drive or UNC) count as Windows, posix ones do not", () => {
  expect(isWindowsPath("C:\\Users\\x\\scratch")).toBe(true);
  expect(isWindowsPath("c:/Users/x")).toBe(true);
  expect(isWindowsPath("\\\\wsl$\\Ubuntu\\tmp")).toBe(true);
  expect(isWindowsPath("/tmp/claude-1000/x")).toBe(false);
});
