/**
 * notify.ts - macOS notification for a newly raised alert.
 *
 * Only fires on the transition into an alert state, never on every probe,
 * because raiseAlert() is idempotent per open alert code. Silent between
 * 21:00 and 08:30 to match the Voice Experience Contract's quiet hours: the
 * alert still lands in the database and the menu bar, it just does not make
 * noise overnight.
 */

function inQuietHours(d = new Date()): boolean {
  const mins = d.getHours() * 60 + d.getMinutes()
  return mins >= 21 * 60 || mins < 8 * 60 + 30
}

export function notify(title: string, body?: string): void {
  if (inQuietHours()) return
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&")
  try {
    Bun.spawn([
      "osascript",
      "-e",
      `display notification "${esc(body ?? "")}" with title "Starlink" subtitle "${esc(title)}"`,
    ])
  } catch {
    /* a failed notification must never break a probe */
  }
}
