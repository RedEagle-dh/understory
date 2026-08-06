/**
 * Lightweight relative/absolute time formatting shared by RelativeTime and
 * anywhere else timestamps show up. No date library — the ranges we need
 * (seconds through "beyond a week") are simple enough to hand-roll.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

function toDate(date: Date | string | number): Date {
  return date instanceof Date ? date : new Date(date)
}

export function formatRelative(
  date: Date | string | number,
  now: Date | string | number = new Date()
): string {
  const target = toDate(date)
  const reference = toDate(now)
  const diffMs = reference.getTime() - target.getTime()
  const abs = Math.abs(diffMs)
  const future = diffMs < 0

  if (abs < MINUTE) return "just now"

  if (abs < HOUR) {
    const mins = Math.round(abs / MINUTE)
    return future ? `in ${mins}m` : `${mins}m ago`
  }

  if (abs < DAY) {
    const hours = Math.round(abs / HOUR)
    return future ? `in ${hours}h` : `${hours}h ago`
  }

  if (abs < 2 * DAY) {
    return future ? "tomorrow" : "yesterday"
  }

  if (abs < WEEK) {
    const days = Math.round(abs / DAY)
    return future ? `in ${days}d` : `${days}d ago`
  }

  return formatAbsoluteDate(target)
}

export function formatAbsoluteDate(date: Date | string | number): string {
  return toDate(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function formatAbsolute(date: Date | string | number): string {
  return toDate(date).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
