# Decisions

Yours to write, not your AI's. Short is good — bullets are fine, and half a page is
plenty. We read this first.

## What did the spec not tell you?

There are things this brief doesn't specify. Which ones did you hit, what did you decide,
and why?

- Week starts on Monday, using the ISO 8601 standard. This matches Postgres
  `date_trunc('week', d)`, so the client and server use the same week start.
- Weekends are included. The same `hours_per_day` value is used for every day,
  and the data does not say which days are workdays. If holidays or part-time
  schedules are needed later, they can be added in a separate table for each
  person.
- Range snapping: `from` snaps down to its Monday, `to` snaps up to its Sunday,
  so the grid always shows whole weeks.
- Range cap: the server only allows up to 104 weeks, which is two years. If
  the date range is longer, it returns a 400 error.
- The API groups the data by person. Everyone shares the same list of weeks.
  Each person has a matching list of allocation numbers. Capacity is one value
  for each person because that is how the data is stored. This keeps the
  response small and easy for the client to use.
- Over-allocation styling: red fill at 100% or above, amber at 90% or above,
  neutral below. Three states felt right for "obvious at a glance" without
  being noisy.
- Used TanStack Query for the capacity read and the edit mutation.
  Cancellation, cache snapshotting for rollback, and the no-invalidate
  decision below all live there. Chose it over a hand-rolled fetch because it
  keeps the optimistic path short and the retry and stale rules in one place.
- When a user makes a change, the page updates right away. If saving fails,
  it goes back to the old value and shows a retry option. After saving, the
  page uses the value returned by the server. I do not reload the capacity
  data after every save because only capacity changes. The allocation data
  comes from assignments, so it stays correct. This saves one extra server
  request for each change.
- Query defaults: 10 second `staleTime` so a quick back-and-forth on the
  range does not refetch twice. `refetchOnWindowFocus` off so returning to
  the tab does not blow away an in-progress edit. Mutations do not retry,
  because 400s (negative hours, out of range) are user-fixable, not transient.
- If the manager changes the date range before the request finishes,
  `AbortController` cancels the old request. This stops old data from
  replacing the new data.
- Invalid ranges (`to` earlier than `from`): the server returns a 400 with
  `"to is before from"` and the UI shows a clean inline error rather than
  stale data. Client inputs are permissive on purpose; the server is the
  source of truth on validity. Defense in depth.

## What did you notice that looked wrong?

Anything in the output that didn't match what you expected. Whether you fixed it or left
it, we want to know you saw it.

The week starting 2026-02-02 has no assignments for any of the 500 people. The weeks before and after it have many assignments. I checked the data with this query:

```sql
  SELECT COUNT(*) FROM assignments
  WHERE start_date <= DATE '2026-02-08'
    AND end_date   >= DATE '2026-02-02';
  -- returns 0
```

It returned 0, so this is real data, not a bug. The grid is showing the empty week correctly, but it may be confusing for a manager.

Eli Nakamura has `0` capacity but has `20` hours of work in week 1. The system already handles this case. Any work assigned to someone with zero capacity is shown as over capacity. This is real data, so it confirms that the check is needed.

## What did the AI get wrong that you caught?

One concrete example. Every real session has one.

- At first, the overlap calculation missed `+ 1`. This made single-day assignments count one day too little. It also gave the wrong result for assignments that cross into another week. I added `+ 1` to fix the calculation. I also added a Go test for an assignment that crosses two weeks.

## What would you do differently with a week?

- A saved capacity view uses `person_id` and `week_start` as its keys. Triggers update it when assignments change. This is useful for a large system with 2,000 people over two years. It is more than needed for the small sample data.
- For a grid with thousands of rows, only show the rows that are visible on the screen. A tool like `react-window` can do this and keep the page fast.
- If the end date is before the start date, the server returns a `400` error with the message: “to is before from.” The page shows this error clearly instead of showing incorrect data. The server decides if the dates are valid. A single date picker could stop this earlier, but that is a user experience improvement, not a required fix.
- Each person can have their own working-day settings for capacity. This can include public holidays in their country and part-time work schedules.
- Use server-sent events on `/api/capacity` so changes made by one manager appear on another manager’s grid without reloading the data.
