import { useState } from 'react'
import { CapacityGrid } from './CapacityGrid'
import { addDays, isoDate, parseIsoDate, snapToMonday } from './dates'

// Default range: the week containing today plus three following weeks.
// Managers almost always want "this week forward", not "last month".
const today = snapToMonday(new Date())
const DEFAULT_FROM = isoDate(today)
const DEFAULT_TO = isoDate(addDays(today, 27))

export function App() {
  const [from, setFrom] = useState(DEFAULT_FROM)
  const [to, setTo] = useState(DEFAULT_TO)

  // Keyboard-friendly week nav: shift both bounds by seven days together.
  const shiftWeeks = (weeks: number) => {
    setFrom(isoDate(addDays(parseIsoDate(from), weeks * 7)))
    setTo(isoDate(addDays(parseIsoDate(to), weeks * 7)))
  }

  return (
    <main>
      <h1>Team capacity</h1>

      <div className="toolbar">
        <button type="button" onClick={() => shiftWeeks(-1)} aria-label="Previous week">
          ← Prev week
        </button>
        <button type="button" onClick={() => shiftWeeks(1)} aria-label="Next week">
          Next week →
        </button>

        <label>
          From
          <input
            type="date"
            value={from}
            required
            // A cleared native date input reports ''; keep the last real date
            // rather than requesting from= and breaking week navigation.
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            required
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>

        <span className="range">
          {from} to {to}
        </span>
      </div>

      <CapacityGrid from={from} to={to} />
    </main>
  )
}
