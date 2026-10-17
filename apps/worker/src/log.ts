import { type Logger, pino } from "pino";

export type { Logger };

// Secrets never reach a log call by construction (the token lives only in the API client, and presigned URLs are
// logged through safeUrl). The redact list is defence in depth for anything that slips through as an object.
const REDACT = [
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "url",
  "*.url",
  "uploads",
  "*.uploads",
  "assets[*].url",
  "*.assets[*].url",
];

export function createLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  return pino(
    {
      level,
      base: { svc: "keyframe-worker" },
      redact: { paths: REDACT, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination ?? process.stdout,
  );
}

/** Origin + path only: presigned URLs carry their signature in the query string. */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}
