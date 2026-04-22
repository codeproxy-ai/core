/** Safe JSON helpers used by translators. */

export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function jsonStringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
