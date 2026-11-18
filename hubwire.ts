/**
 * Calls to the Hub's web endpoints with a session's cookies. A redirect, a
 * 401 or an empty answer is how the Hub says "the session ended"; that is a
 * `LoginRequiredError`, which `HubSession` answers with one renewal and one retry.
 */

import { type CookieJar, type FetchLike, send } from "./http";
import { HUB_ORIGIN, InfoMentorError, LoginRequiredError } from "./saml";
import { addDays, today } from "./time";

const AJAX = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
};

/** POST a Hub endpoint and parse its JSON. */
export async function hubPost(
  fetcher: FetchLike,
  jar: CookieJar,
  path: string,
  payload: unknown,
  form = false,
): Promise<unknown> {
  const hop = await send(fetcher, HUB_ORIGIN + path, {
    jar,
    headers: AJAX,
    ...(form ? { form: payload as Record<string, string> } : { json: payload }),
  });
  if (hop.status >= 300 && hop.status < 400) {
    throw new LoginRequiredError("The InfoMentor session ended.");
  }
  if (hop.status === 401) throw new LoginRequiredError("The InfoMentor session ended.");
  if (hop.status === 403) throw new InfoMentorError("InfoMentor denied access (HTTP 403).");
  if (hop.status >= 400) throw new InfoMentorError(`InfoMentor answered HTTP ${hop.status}.`);
  if (hop.text.trim() === "") throw new LoginRequiredError("InfoMentor returned an empty answer.");
  try {
    return JSON.parse(hop.text) as unknown;
  } catch {
    throw new InfoMentorError("InfoMentor did not answer with JSON.");
  }
}

/** GET a Hub page (HTML) with the session's cookies. */
export async function hubPage(fetcher: FetchLike, jar: CookieJar, path: string): Promise<string> {
  const hop = await send(fetcher, HUB_ORIGIN + path, { jar });
  if ((hop.status >= 300 && hop.status < 400) || hop.status === 401) {
    throw new LoginRequiredError("The InfoMentor session ended.");
  }
  if (hop.status === 403) throw new InfoMentorError("InfoMentor denied access (HTTP 403).");
  if (hop.status >= 400) throw new InfoMentorError(`InfoMentor answered HTTP ${hop.status}.`);
  if (hop.text.trim() === "") throw new LoginRequiredError("InfoMentor returned an empty page.");
  return hop.text;
}

/** A read-only request that proves the cookies are a signed-in Hub session. */
export async function verifyHubSession(fetcher: FetchLike, jar: CookieJar): Promise<void> {
  const start = today();
  const payload = { startDate: start, endDate: addDays(start, 1) };
  const answer = await hubPost(fetcher, jar, "/timetable/timetable/appData", payload);
  const items = (answer as { items?: unknown } | null)?.items;
  if (!Array.isArray(items))
    throw new InfoMentorError("The new session did not pass the Hub check.");
}
