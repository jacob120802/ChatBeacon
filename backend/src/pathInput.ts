/** Returns null for malformed percent-encoding instead of throwing in a request handler. */
export function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
