/**
 * The little HTML this extension has to read: login pages with a form to
 * submit on to the next hop, and news text to show as Markdown.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[entity.toLowerCase()] ?? whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    const name = (match[1] ?? "").toLowerCase();
    found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return found;
}

export type HtmlForm = { action: string; fields: Record<string, string> };

export type LoginPage = {
  forms: HtmlForm[];
  /** The first link to `NECSadc/mbid`: the BankID entry of Stockholm's login page. */
  mbidHref: string | null;
  /** The first form with one of the named fields. */
  formWith(...names: string[]): HtmlForm | null;
};

function inputFields(formBody: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const input of formBody.matchAll(/<input\b([^>]*)>/gi)) {
    const found = attributes(input[1] ?? "");
    const name = found["name"];
    if (name !== undefined && name !== "") fields[name] = found["value"] ?? "";
  }
  return fields;
}

export function parseLoginPage(html: string): LoginPage {
  const forms: HtmlForm[] = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(
    (form) => ({
      action: attributes(form[1] ?? "")["action"] ?? "",
      fields: inputFields(form[2] ?? ""),
    }),
  );
  const hrefs = [...html.matchAll(/<a\b([^>]*)>/gi)].map(
    (a) => attributes(a[1] ?? "")["href"] ?? "",
  );
  const mbidHref = hrefs.find((href) => href.includes("NECSadc/mbid")) ?? null;
  return {
    forms,
    mbidHref,
    formWith: (...names) => forms.find((form) => names.some((name) => name in form.fields)) ?? null,
  };
}

/** News and calendar text arrive as HTML; a session reads it as plain text. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
