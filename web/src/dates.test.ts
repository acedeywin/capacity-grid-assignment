import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addDays, isoDate, parseIsoDate } from './dates'

// Week navigation must not drift west of UTC: new Date('YYYY-MM-DD') is UTC
// midnight, which reads back as the previous local day in New York.
describe('week navigation round-trip', () => {
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/New_York')
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('is actually running west of UTC', () => {
    // Guards against the TZ stub silently not applying, which would make the
    // tests below pass vacuously.
    expect(new Date(2026, 9, 5).getTimezoneOffset()).toBe(240)
  })

  it('stays on Mondays after repeated +7 day shifts', () => {
    let d = '2026-10-05'
    for (let i = 0; i < 3; i++) d = isoDate(addDays(parseIsoDate(d), 7))
    expect(d).toBe('2026-10-26')
  })

  it('crosses the DST change without slipping a day', () => {
    // US clocks fall back on 2026-11-01.
    expect(isoDate(addDays(parseIsoDate('2026-10-26'), 7))).toBe('2026-11-02')
  })
})
