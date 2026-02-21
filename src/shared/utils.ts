/**
 * Claude Team - Shared Utilities
 */

/**
 * ISO 8601 timestamp for the current instant.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Safely parse JSON with fallback on failure.
 */
export function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
