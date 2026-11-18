/**
 * Where a tool puts a file for the session: the session's scratchpad when the
 * host can write there, else a folder it can. A session in WSL has a scratchpad
 * like /tmp/claude-1000/... that a host on Windows cannot create, so the first
 * candidate is proved with a real write instead of trusted.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi, ExtensionToolContext } from "@prifly/extension-api";

const NAME = "infomentor";

/** The session's scratchpad, or undefined where prifly cannot give one (reading it may throw). */
function scratchpadOf(ctx: ExtensionToolContext): string | undefined {
  try {
    const path = ctx.scratchpad;
    return typeof path === "string" && path !== "" ? path : undefined;
  } catch {
    return undefined;
  }
}

/** A Windows path (drive or UNC): the only kind a Windows host can use as a scratchpad. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Makes the folder and writes then removes a probe file in it; false when the host cannot. */
async function usable(folder: string): Promise<boolean> {
  try {
    await mkdir(folder, { recursive: true });
    const probe = join(folder, `.probe-${process.pid}-${Date.now()}`);
    await writeFile(probe, "");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The folder for this call's files, made: `<scratchpad>/infomentor` when the
 * host can write it, else the extension's own folder (`api.folder`, as the
 * other prifly extensions do when the scratchpad is no use), else a fresh
 * private folder under the OS temp directory.
 */
export async function sessionFolder(
  api: ExtensionApi | null,
  ctx: ExtensionToolContext,
  platform: string = process.platform,
): Promise<string> {
  const candidates: string[] = [];
  const scratchpad = scratchpadOf(ctx);
  // A WSL session's /tmp/... would be made on the Windows drive, where the session cannot open it.
  const foreign = platform === "win32" && scratchpad !== undefined && !isWindowsPath(scratchpad);
  if (scratchpad !== undefined && !foreign) candidates.push(join(scratchpad, NAME));
  if (api !== null && api.folder !== "") candidates.push(join(api.folder, "files"));
  for (const candidate of candidates) {
    if (await usable(candidate)) return candidate;
  }
  // Last resort: a fresh folder only this user can open (mkdtemp makes it 0700), never a shared
  // fixed name in the temp directory that another local user could own or read.
  try {
    return await mkdtemp(join(tmpdir(), `prifly-ext-${NAME}-`));
  } catch {
    // fall through to the error below
  }
  throw new Error("No folder the host can write to was found for the file.");
}
