import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { decodeEntities, htmlToText, parseLoginPage } from "../html";
import { CookieJar } from "../http";
import { parseCalendar, parseLessons, parseNews, parseNotifications } from "../parse";
import { qrPng } from "../qr";
import { InfoMentorError, validateAuthUrl } from "../saml";
import { addDays, mondayOf, stockholmOffsetMinutes, wallClock } from "../time";
import { EVENT, LESSON, NEWS, NOTIFICATION } from "./world";

test("the cookie jar sends host-only and domain cookies to the right hosts and paths", () => {
  const jar = new CookieJar();
  jar.store("https://hub.infomentor.se/a/b", [
    "one=1; Path=/; Secure; HttpOnly",
    "two=2; Domain=infomentor.se; Path=/a",
    "gone=x; Max-Age=0",
    "evil=1; Domain=example.com",
  ]);
  expect(jar.header("https://hub.infomentor.se/a/b")).toBe("two=2; one=1");
  expect(jar.header("https://hub.infomentor.se/other")).toBe("one=1");
  expect(jar.header("https://sso.infomentor.se/a")).toBe("two=2");
  expect(jar.header("https://other.example/a")).toBeNull();
  jar.store("https://hub.infomentor.se/", ["one=changed; Path=/"]);
  expect(jar.header("https://hub.infomentor.se/")).toBe("one=changed");
  jar.store("https://hub.infomentor.se/", ["one=; Max-Age=0; Path=/"]);
  expect(jar.header("https://hub.infomentor.se/")).toBeNull();
});

test("authentication redirects go only to InfoMentor and Stockholm stad over https", () => {
  expect(validateAuthUrl("/x", "https://sso.infomentor.se/a")).toBe("https://sso.infomentor.se/x");
  expect(validateAuthUrl("https://login.stockholm.se/start")).toBe(
    "https://login.stockholm.se/start",
  );
  for (const bad of [
    "http://hub.infomentor.se/",
    "https://evil.example/",
    "https://infomentor.se.evil.example/",
    "https://evilstockholm.se/",
  ]) {
    expect(() => validateAuthUrl(bad)).toThrow(InfoMentorError);
  }
});

test("login pages: forms with decoded fields, and the BankID link", () => {
  const page = parseLoginPage(
    `<a href="/NECSadc/mbid/x?a=1&amp;b=2">go</a>
     <form action='/acs?x=1&amp;y=2' method=post>
       <input type=hidden name="SAMLResponse" value="a&#43;b&amp;c"><input name=RelayState value="">
     </form>`,
  );
  expect(page.mbidHref).toBe("/NECSadc/mbid/x?a=1&b=2");
  expect(page.formWith("SAMLResponse")).toEqual({
    action: "/acs?x=1&y=2",
    fields: { SAMLResponse: "a+b&c", RelayState: "" },
  });
  expect(page.formWith("Missing")).toBeNull();
});

test("html text: breaks, lists, entities, and no scripts", () => {
  expect(decodeEntities("&lt;b&gt; &#xe5; &#229; &unknown;")).toBe("<b> å å &unknown;");
  expect(htmlToText("<p>Hej<br/>då</p><ul><li>a</li><li>b</li></ul><script>x()</script>")).toBe(
    "Hej\ndå\n- a\n- b",
  );
});

test("Stockholm time: wall clock kept, instants converted, DST offset right", () => {
  expect(wallClock("2026-11-16T08:15:00")).toEqual({ date: "2026-11-16", time: "08:15" });
  expect(wallClock("2026-07-01T10:00:00Z")).toEqual({ date: "2026-07-01", time: "12:00" });
  expect(wallClock("2026-01-01T23:30:00+00:00")).toEqual({ date: "2026-01-02", time: "00:30" });
  expect(wallClock("2026-11-16")).toEqual({ date: "2026-11-16", time: "00:00" });
  expect(wallClock("soon")).toBeNull();
  expect(wallClock(5)).toBeNull();
  expect(stockholmOffsetMinutes("2026-11-16")).toBe(60);
  expect(stockholmOffsetMinutes("2026-07-01")).toBe(120);
  expect(mondayOf("2026-11-22")).toBe("2026-11-16");
  expect(mondayOf("2026-11-16")).toBe("2026-11-16");
  expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
});

test("parsing: lessons, news, calendar and notifications fail closed per row", () => {
  expect(parseLessons([LESSON, 5, { title: "x" }])).toMatchObject({
    skipped: 2,
    items: [{ title: "Matematik", room: "A12" }],
  });
  const news = parseNews({ items: [NEWS, { title: "no id" }] });
  expect(news.skipped).toBe(1);
  expect(news.items[0]?.attachments).toEqual([{ id: "777", name: "Lista.pdf" }]);
  expect(parseNews({ nope: 1 })).toEqual({ items: [], skipped: 0 });
  expect(parseCalendar([EVENT, { ...EVENT, isAllDayEvent: "yes" }])).toMatchObject({
    skipped: 1,
    items: [{ id: "900", allDay: true }],
  });
  expect(
    parseNotifications({
      notifications: [NOTIFICATION, { ...NOTIFICATION, currentlySelectedPupil: false }],
    }).items,
  ).toHaveLength(1);
});

test("the QR image is a valid PNG of the right size", () => {
  const png = qrPng("bankid.1234");
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset);
  const width = view.getUint32(16);
  expect(view.getUint32(20)).toBe(width);
  expect(width % 10).toBe(0);
  // Inflate the first IDAT: one filter byte plus one byte per pixel, per row.
  const length = view.getUint32(33);
  expect(String.fromCharCode(...png.subarray(37, 41))).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + length));
  expect(raw.length).toBe((width + 1) * width);
  // The quiet zone is white.
  expect(raw[1]).toBe(255);
  expect(qrPng("bankid.1235")).not.toEqual(png);
});
