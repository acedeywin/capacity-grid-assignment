// Small date helpers. Kept dependency-free on purpose: date-fns is nice but
// the two helpers we actually need fit in ten lines, and shipping an extra
// package for them is the wrong trade here.

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Parse YYYY-MM-DD as local midnight. `new Date('2026-10-05')` is UTC midnight,
// which isoDate (local getters) reads back as the previous day anywhere west
// of UTC — week navigation then drifts a day per click.
export function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + days)
  return copy
}

// Snap d back to the Monday of its ISO week.
// JavaScript Date#getDay(): Sunday=0 .. Saturday=6. We want Sunday to count
// as the end of the previous week (ISO), so treat 0 as 7.
export function snapToMonday(d: Date): Date {
  const wd = d.getDay() === 0 ? 7 : d.getDay()
  return addDays(d, -(wd - 1))
}
