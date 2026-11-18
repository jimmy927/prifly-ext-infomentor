/**
 * Reads from the Hub, for one pupil or all of them. Read-only: nothing here
 * marks a notification seen, follows a link in school text, or writes to a
 * childcare schedule.
 */

import { type CookieJar, type FetchLike, sendBinary } from "./http";
import { hubPost } from "./hubwire";
import {
  type CalendarEntry,
  type Lesson,
  type NewsItem,
  type Notification,
  type Parsed,
  parseCalendar,
  parseLessons,
  parseNews,
  parseNotifications,
} from "./parse";
import { choosePupils, discoverPupils, type Pupil, select } from "./pupils";
import { HUB_ORIGIN, InfoMentorError, LoginRequiredError } from "./saml";
import type { HubSession } from "./session";
import { addDays, stockholmOffsetMinutes } from "./time";

export type ForPupil<T> = { pupil: Pupil; data: T };

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class Hub {
  private readonly fetcher: FetchLike;
  private readonly session: HubSession;

  constructor(fetcher: FetchLike, session: HubSession) {
    this.fetcher = fetcher;
    this.session = session;
  }

  /**
   * Runs `read` once per chosen pupil, selecting each first and putting the
   * original selection back afterwards.
   */
  private visit<T>(
    wanted: unknown,
    read: (jar: CookieJar, pupil: Pupil) => Promise<T>,
  ): Promise<ForPupil<T>[]> {
    return this.session.run(async (jar) => {
      this.session.pupils ??= await discoverPupils(this.fetcher, jar);
      const state = this.session.pupils;
      const targets = choosePupils(state.pupils, wanted);
      const out: ForPupil<T>[] = [];
      try {
        for (const pupil of targets) {
          await select(this.fetcher, jar, state, pupil.id);
          out.push({ pupil, data: await read(jar, pupil) });
        }
      } finally {
        await select(this.fetcher, jar, state, state.original).catch(() => undefined);
      }
      return out;
    });
  }

  async pupils(): Promise<Pupil[]> {
    return await this.session.run(async (jar) => {
      this.session.pupils ??= await discoverPupils(this.fetcher, jar);
      return this.session.pupils.pupils;
    });
  }

  /** The lessons of the week that starts on `monday`. */
  timetable(monday: string, pupil?: unknown): Promise<ForPupil<Parsed<Lesson>>[]> {
    const payload = {
      start: monday,
      end: addDays(monday, 7),
      UTCOffset: String(-stockholmOffsetMinutes(monday)),
    };
    return this.visit(pupil, async (jar) =>
      parseLessons(
        await hubPost(this.fetcher, jar, "/timetable/timetable/gettimetablelist", payload, true),
      ),
    );
  }

  news(pupil?: unknown): Promise<ForPupil<Parsed<NewsItem>>[]> {
    return this.visit(pupil, async (jar) =>
      parseNews(await hubPost(this.fetcher, jar, "/Communication/News/GetNewsList", {})),
    );
  }

  calendar(from: string, to: string, pupil?: unknown): Promise<ForPupil<Parsed<CalendarEntry>>[]> {
    const payload = { startDate: from, endDate: to };
    return this.visit(pupil, async (jar) =>
      parseCalendar(await hubPost(this.fetcher, jar, "/calendarv2/calendarv2/getentries", payload)),
    );
  }

  notifications(pupil?: unknown): Promise<ForPupil<Parsed<Notification>>[]> {
    return this.visit(pupil, async (jar) =>
      parseNotifications(
        await hubPost(this.fetcher, jar, "/NotificationApp/NotificationApp/GetNotifications", {}),
      ),
    );
  }

  /**
   * One attachment of a news item, found again in that pupil's current news
   * (a caller never supplies the URL) and downloaded.
   */
  async attachment(
    pupil: unknown,
    newsId: string,
    attachmentId: string,
  ): Promise<{ name: string; bytes: Uint8Array }> {
    const visits = await this.visit(pupil, async (jar) => {
      const news = parseNews(
        await hubPost(this.fetcher, jar, "/Communication/News/GetNewsList", {}),
      );
      const ref = news.items
        .find((item) => item.id === newsId)
        ?.attachments.find((a) => a.id === attachmentId);
      if (ref === undefined) return null;
      const query = new URLSearchParams({
        api: "IM2",
        ModuleType: "NewsItem",
        ConnectionId: newsId,
      });
      const url = `${HUB_ORIGIN}/Resources/Resource/Download/${attachmentId}?${query.toString()}`;
      const got = await sendBinary(this.fetcher, url, jar, MAX_ATTACHMENT_BYTES);
      if (got.status === 401 || (got.status >= 300 && got.status < 400)) {
        throw new LoginRequiredError("The InfoMentor session ended.");
      }
      if (got.status === 413) throw new InfoMentorError("The attachment is larger than 25 MB.");
      if (got.bytes === null)
        throw new InfoMentorError(`The download failed (HTTP ${got.status}).`);
      return { name: ref.name, bytes: got.bytes };
    });
    const found = visits.find((visit) => visit.data !== null)?.data;
    if (found === undefined || found === null) {
      throw new InfoMentorError("That attachment is not in the news of the chosen pupil(s).");
    }
    return found;
  }
}
