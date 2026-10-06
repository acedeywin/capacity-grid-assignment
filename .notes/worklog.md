# Worklog

Running notes on how this got built — decisions, assumptions, dead ends, and anything
left unfinished. Append as you go; a line or two per entry is right.

---

- Read scaffold, schema, and a sample of seed. 500 people, ~126k assignments, assignments
  have arbitrary date ranges and a `hours_per_day` daily rate.
- Decided API shape: nested-by-person with a shared `weeks` array, allocation as a parallel
  float array per person. Keeps bandwidth low and reads naturally for a 2D grid.
- Decided week boundaries: ISO 8601 Monday-start, same as Postgres `date_trunc('week', d)`.
  `from` snaps down to its Monday, `to` snaps up to its Sunday. Grid always shows whole
  weeks.
- Weekend handling: counted. Nothing in the schema distinguishes workdays and the seed's
  `hours_per_day` is uniform across arbitrary ranges, so applying it per calendar day is
  consistent with the input. Noted as a thing to revisit with a per-person working-days
  table.
- Range cap: 104 weeks server-side (production ceiling named in the brief). Over that
  returns 400.
- Computed allocation entirely in SQL in one query: `generate_series` for the week
  buckets, cross join people × weeks, left join assignments with the overlap filter,
  sum of `GREATEST(0, LEAST(end, w+6) - GREATEST(start, w) + 1) * hours_per_day` per
  cell. Index on `(start_date, end_date)` carries the overlap predicate.
- Edit path for weekly_hours: optimistic patch of the TanStack Query cache, no
  invalidation on success. Changing `weekly_hours` only moves capacity; allocation
  comes from assignments and does not move, so the cached allocation stays correct.
  Over-allocation styling re-derives from `allocated vs weekly_hours` and updates
  immediately. On error, roll back the cache snapshot from `onMutate` and show an
  inline retry on the affected row. This is the eventual-consistency decision point
  for this surface.
- Pulled in `@tanstack/react-query` after noticing the JD calls out TanStack and
  "real understanding of frontend caching and eventual consistency" as a bonus.
  `useQuery` keyed by `[capacity, from, to]`; its built-in AbortSignal cancels a
  slow in-flight load if the manager pages to a new range before it returns.
  `useMutation` for the edit with `onMutate` / `onError` / `onSuccess` / `onSettled`
  carrying the snapshot through for rollback.
- Query defaults deliberately boring: 10s staleTime so a range toggle doesn't
  refetch twice, `refetchOnWindowFocus: false` to stop a focus event from blowing
  away an in-progress edit, mutations with `retry: false` because our 400s are
  user-fixable, not transient.
- Over-allocation thresholds: >= 100% red, >= 90% amber, below neutral. Three states felt
  right for "obvious at a glance" without being noisy.
- Tests: one Go table-driven test on the overlap math (single-day, straddling, whole
  week, outside range), one React test on the optimistic revert flow.
- Caught by review of the AI's first pass at the overlap math: used
  `LEAST(end, w+6) - GREATEST(start, w)` without the `+ 1` and under-counted single-day
  assignments by one. Added it and the straddle test caught it.
- Opened the grid against the seed. Noticed the week starting 2026-02-02 was
  empty across every one of the 500 people, with the surrounding weeks heavily
  booked. Ran `SELECT COUNT(*) FROM assignments WHERE start_date <= '2026-02-08'
  AND end_date >= '2026-02-02';` to rule out an overlap bug. Returned 0. The
  seed deliberately has a dead week there; the grid is faithfully reporting it.

## Deferred

- Materialised capacity view keyed by (person_id, week_start) with triggers on
  assignments. Right play for the 2000-person × 2-year case; overkill at seed scale.
- Virtualised rows in the grid. Current render handles 500 rows fine; past ~1000 I'd
  reach for react-window or similar.
- A unified date-range picker (one popover selecting both bounds, with
  enforced `to >= from`) and preset chips (This quarter, Next quarter,
  Next 4 weeks). Two native inputs are fine for a 90-minute cut; a dedicated
  range widget would cut the common path from four clicks to one.
- Per-person working-days configuration feeding capacity (holidays, part-time patterns).
- SSE on the capacity endpoint so a second manager's edit updates the first manager's grid
  without a refetch.

## Review fixes (2026-10-06)

- The revert test was failing: a fast PATCH failure took the cache 40 → 36 → 40 in one
  render batch, so the draft-sync effect never fired and the input kept the rejected
  value. The effect now also depends on the row error.
- Retry resent the reverted value (a no-op). Row errors now carry the attempted value
  and Retry sends that.
- Rollback used to restore a whole-dataset snapshot, which could undo a concurrent
  successful save on another row, and was written to whichever range was visible at
  error time. Now: patch/rollback is per person (`prev` travels in the mutation vars)
  and applied to every cached `['capacity', …]` range with `setQueriesData`, so a
  range navigated away from doesn't come back with stale capacity. Still no refetch
  after save; the only queries reloaded are ones the save cancelled mid-flight.
- `keepPreviousData` on the capacity query: prev/next keeps the old grid dimmed with
  "Loading range…" instead of blanking 500 rows. Load errors get a Retry button.
- Week navigation drifted a day per click west of UTC (`new Date('YYYY-MM-DD')` is UTC
  midnight; helpers use local getters). Added `parseIsoDate` for local parsing; test
  runs under America/New_York.
- Corrected an earlier note: the (start_date, end_date) index was NOT carrying the
  overlap predicate. EXPLAIN showed a seq scan with 13M rows dropped in a join filter
  (~580ms at 104 weeks). Query now pre-filters assignments to the range, expands each
  into only the weeks it overlaps (lateral generate_series), then joins onto
  people × weeks. Output verified identical to the old query over 51 weeks × 500
  people. 104 weeks: ~60ms.
- JIT was costing ~250ms per request because the planner can't estimate a lateral
  generate_series and guesses 1000 rows. `SET LOCAL jit = off` in a per-request
  transaction rather than changing server config.
- 500s now log the DB error and return "internal error". Empty roster encodes
  `people: []`, and weeks are built in Go from the snapped range.
- Not changed, still open: the seed has 126,195 assignment rows but only 16,826
  distinct (every id ≥ 8414 is an exact copy), and `hours_per_day` is 0.125–1.0 in
  eighths, which reads like a fraction of a day. The query sums every row and treats
  the rate as hours, so these are interpretation calls that need deciding.
