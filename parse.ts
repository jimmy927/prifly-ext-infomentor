/**
 * Hub's JSON turned into plain records. A row that does not look like what the
 * Hub sends is left out and counted, never guessed at: the reader is told how
 * many could not be read.
 */

import { type WallClock, wallClock } from "./time";

export type Parsed<T> = { items: T[]; skipped: number };

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function each<T>(rows: unknown, read: (row: Record<string, unknown>) => T | null): Parsed<T> {
  const items: T[] = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = isRecord(row) ? read(row) : null;
    if (item === null) skipped += 1;
    else items.push(item);
  }
  return { items, skipped };
}

export type Lesson = {
  title: string;
  start: WallClock;
  end: WallClock;
  allDay: boolean;
  room: string | null;
  teachers: string | null;
  notes: string | null;
  details: string | null;
  establishment: string | null;
};

/** `gettimetablelist`: an array of lessons. */
export function parseLessons(rows: unknown): Parsed<Lesson> {
  return each(rows, (row) => {
    const start = wallClock(row["start"]);
    const end = wallClock(row["end"]);
    const notes = isRecord(row["notes"]) ? row["notes"] : {};
    if (typeof row["title"] !== "string" || typeof row["allDay"] !== "boolean") return null;
    if (start === null || end === null) return null;
    return {
      title: row["title"],
      start,
      end,
      allDay: row["allDay"],
      room: text(notes["roomInfo"]),
      teachers: text(notes["tutors"]),
      notes: text(notes["timetableNotes"]),
      details: text(row["details"]),
      establishment: text(row["establishmentName"]),
    };
  });
}

export type AttachmentRef = { id: string; name: string };

export type NewsItem = {
  id: string;
  title: string | null;
  content: string | null;
  published: WallClock | null;
  attachments: AttachmentRef[];
};

/**
 * Only Hub's own download references for this news item count as attachments:
 * `/Resources/Resource/Download/<digits>?api=IM2&ModuleType=NewsItem&ConnectionId=<news id>`.
 */
function attachmentRefs(newsId: string, raw: unknown): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item) || typeof item["url"] !== "string") continue;
    try {
      const url = new URL(item["url"], "https://hub.infomentor.se");
      const id = url.pathname.replace("/Resources/Resource/Download/", "");
      const query = [...url.searchParams.entries()].sort().join("&");
      const expected = [
        ["ConnectionId", newsId],
        ["ModuleType", "NewsItem"],
        ["api", "IM2"],
      ].join("&");
      if (
        url.origin === "https://hub.infomentor.se" &&
        url.pathname.startsWith("/Resources/Resource/Download/") &&
        /^\d+$/.test(id) &&
        query === expected
      ) {
        refs.push({ id, name: text(item["title"]) ?? `attachment-${id}` });
      }
    } catch {
      // Not a reference to a download: not an attachment.
    }
  }
  return refs;
}

/** `GetNewsList`: `{ items: [...] }`. */
export function parseNews(body: unknown): Parsed<NewsItem> {
  const rows = isRecord(body) ? body["items"] : undefined;
  return each(rows, (row) => {
    const id = row["id"];
    if (id === null || id === undefined || typeof id === "boolean" || String(id).trim() === "")
      return null;
    return {
      id: String(id),
      title: text(row["title"]),
      content: text(row["content"]),
      published: wallClock(row["publishedDate"]),
      attachments: attachmentRefs(String(id), row["attachments"]),
    };
  });
}

export type CalendarEntry = {
  id: string;
  title: string | null;
  description: string | null;
  start: WallClock;
  end: WallClock;
  allDay: boolean;
  hasAttachments: boolean;
};

/** `getentries`: an array of events. */
export function parseCalendar(rows: unknown): Parsed<CalendarEntry> {
  return each(rows, (row) => {
    const id = row["id"];
    const start = wallClock(row["startDateFull"]);
    const end = wallClock(row["endDateFull"]);
    if (typeof id === "boolean" || (typeof id !== "string" && typeof id !== "number")) return null;
    if (String(id).trim() === "" || typeof row["isAllDayEvent"] !== "boolean") return null;
    if (start === null || end === null) return null;
    return {
      id: String(id),
      title: text(row["title"]),
      description: text(row["text"]) ?? text(row["description"]),
      start,
      end,
      allDay: row["isAllDayEvent"],
      hasAttachments: row["hasAttachments"] === true,
    };
  });
}

export type Notification = {
  id: string;
  title: string | null;
  subtitle: string | null;
  subjects: string | null;
  sent: WallClock | null;
  /** The sort key Hub gives, newest last. */
  order: string;
  type: string | null;
  state: string | null;
};

/** `GetNotifications`: `{ notifications: [...] }`, of which only the selected pupil's rows count. */
export function parseNotifications(body: unknown): Parsed<Notification> {
  const rows = isRecord(body) ? body["notifications"] : undefined;
  const selected: unknown[] = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row) || typeof row["currentlySelectedPupil"] !== "boolean") skipped += 1;
    else if (row["currentlySelectedPupil"]) selected.push(row);
  }
  const parsed = each(selected, (row) => {
    const id = row["id"];
    if (typeof id !== "string" && typeof id !== "number") return null;
    return {
      id: String(id),
      title: text(row["title"]),
      subtitle: text(row["subTitle"]),
      subjects: text(row["subjectsCourses"]),
      sent: wallClock(row["dateSent"]),
      order: text(row["orderDate"]) ?? text(row["dateSent"]) ?? "",
      type: text(row["type"]),
      state: text(row["state"]),
    };
  });
  return { items: parsed.items, skipped: skipped + parsed.skipped };
}
