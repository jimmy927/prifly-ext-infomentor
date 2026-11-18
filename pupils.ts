/**
 * Several children, one Hub session: the Hub shows one selected pupil at a
 * time. Every switch is confirmed by name, and a read puts the original
 * selection back when it is done.
 */

import { decodeEntities } from "./html";
import { type CookieJar, type FetchLike, type Hop, send } from "./http";
import { hubPage } from "./hubwire";
import { HUB_ORIGIN, InfoMentorError, LoginRequiredError } from "./saml";

export type Pupil = { id: string; name: string };

export type PupilState = {
  pupils: Pupil[];
  /** The pupil that was selected when the session was found. */
  original: string;
  /** The pupil the Hub has selected now. */
  current: string;
};

const SWITCH_PATH = /\/Account\/PupilSwitcher\/SwitchPupil\/([^/?#'"\\]+)/gi;
const SELECTED_NAME = /selectedPupilName\s*:\s*'((?:\\.|[^'])*)'/i;

export function parsePupilIds(page: string): string[] {
  return [...new Set([...page.matchAll(SWITCH_PATH)].map((match) => match[1] ?? ""))].filter(
    Boolean,
  );
}

export function selectedName(page: string): string | null {
  const match = SELECTED_NAME.exec(page);
  if (match === null) return null;
  return decodeEntities((match[1] ?? "").replace(/\\'/g, "'").replace(/\\\\/g, "\\"));
}

const normal = (name: string): string =>
  name.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ");

/** Switches pupil, following same-origin redirects only; returns the confirmed page. */
async function switchTo(fetcher: FetchLike, jar: CookieJar, id: string): Promise<string> {
  let url = `${HUB_ORIGIN}/Account/PupilSwitcher/SwitchPupil/${encodeURIComponent(id)}`;
  for (let n = 0; n < 6; n += 1) {
    const hop = await send(fetcher, url, { jar });
    if (hop.status < 300 || hop.status >= 400) return switchedPage(hop);
    url = sameOriginTarget(hop);
  }
  throw new InfoMentorError("The pupil switch exceeded its redirect limit.");
}

function switchedPage(hop: Hop): string {
  if (hop.status === 401) throw new LoginRequiredError("The InfoMentor session ended.");
  if (hop.status === 403)
    throw new InfoMentorError("InfoMentor denied the pupil switch (HTTP 403).");
  if (hop.status >= 400) throw new InfoMentorError(`The pupil switch failed (HTTP ${hop.status}).`);
  if (hop.text === "")
    throw new InfoMentorError("Hub returned an empty page after switching pupil.");
  return hop.text;
}

/** A redirect to anywhere but a Hub page that is not the login means the session ended. */
function sameOriginTarget(hop: Hop): string {
  const target = hop.location === null ? null : new URL(hop.location);
  if (target === null || target.origin !== HUB_ORIGIN || /login/i.test(target.pathname)) {
    throw new LoginRequiredError("The InfoMentor session ended while switching pupil.");
  }
  return target.toString();
}

/** Learns the linked pupils (each confirmed by name) and leaves the original selected. */
export async function discoverPupils(fetcher: FetchLike, jar: CookieJar): Promise<PupilState> {
  const page = await hubPage(fetcher, jar, "/");
  const ids = parsePupilIds(page);
  const initial = selectedName(page);
  if (ids.length === 0 || initial === null) {
    throw new InfoMentorError("The Hub page did not list the linked pupils and the selected one.");
  }
  const pupils: Pupil[] = [];
  let original: string | null = null;
  let current = ids[0] ?? "";
  if (ids.length === 1) {
    return { pupils: [{ id: current, name: initial }], original: current, current };
  }
  for (const id of ids) {
    const name = selectedName(await switchTo(fetcher, jar, id));
    if (name === null)
      throw new InfoMentorError("The Hub did not show the selected pupil after a switch.");
    if (pupils.some((each) => normal(each.name) === normal(name))) {
      throw new InfoMentorError(
        "Pupil selection is ambiguous or a switch was ignored; no school data read.",
      );
    }
    current = id;
    pupils.push({ id, name });
    if (normal(name) === normal(initial)) original = id;
  }
  if (original === null)
    throw new InfoMentorError("Could not tell which pupil was selected first.");
  const state: PupilState = { pupils, original, current };
  await select(fetcher, jar, state, original);
  return state;
}

export async function select(
  fetcher: FetchLike,
  jar: CookieJar,
  state: PupilState,
  id: string,
): Promise<void> {
  const pupil = state.pupils.find((each) => each.id === id);
  if (pupil === undefined) throw new InfoMentorError("That pupil is not linked to this account.");
  if (state.current === id) return;
  const name = selectedName(await switchTo(fetcher, jar, id));
  if (name === null || normal(name) !== normal(pupil.name)) {
    throw new InfoMentorError(
      "The Hub did not confirm the requested pupil; no school data returned.",
    );
  }
  state.current = id;
}

/** Which pupils a tool's `pupil` argument means: an id, a name or part of one; none means all. */
export function choosePupils(pupils: Pupil[], wanted: unknown): Pupil[] {
  if (wanted === undefined || wanted === null || wanted === "") return pupils;
  if (typeof wanted !== "string") throw new InfoMentorError("pupil must be a name or an id.");
  const exact = pupils.filter((each) => each.id === wanted);
  const query = normal(wanted);
  const found =
    exact.length > 0 ? exact : pupils.filter((each) => normal(each.name).includes(query));
  const list = pupils.map((each) => `${each.name} (${each.id})`).join(", ");
  if (found.length === 0)
    throw new InfoMentorError(`No pupil matches "${wanted}". Linked pupils: ${list}.`);
  if (found.length > 1) throw new InfoMentorError(`"${wanted}" matches several pupils: ${list}.`);
  return found;
}
