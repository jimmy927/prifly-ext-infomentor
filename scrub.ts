/** Makes an error's message safe to log and to show a session: nothing that could be a secret. */

const MAX_LENGTH = 300;

/**
 * Conservative: a URL loses its query and fragment, a `token=...` style pair
 * loses its value, and a long run holding a digit (a JWT part, base64, hex, a
 * UUID such as an autostart token) is replaced. Over-redacting is the intent.
 */
export function scrubMessage(message: string): string {
  const scrubbed = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#'")]*)[?#][^\s'")]*/gi, "$1?[redacted]")
    .replace(
      /\b([\w-]*(?:token|secret|cookie|authorization|bearer|password|qr|session|key)[\w-]*)(\s*[=:]\s*)[^\s,;'")]+/gi,
      "$1$2[redacted]",
    )
    .replace(/(?=[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{24,}/g, "[redacted]");
  return scrubbed.length > MAX_LENGTH ? `${scrubbed.slice(0, MAX_LENGTH)}...` : scrubbed;
}

/** What is told about an unexpected error: its name, code and scrubbed message. */
export function describeError(error: unknown): { name: string; code: string; message: string } {
  if (!(error instanceof Error)) return { name: "unknown", code: "", message: "" };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    code: typeof code === "string" ? code : "",
    message: scrubMessage(error.message),
  };
}
