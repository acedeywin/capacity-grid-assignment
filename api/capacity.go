package main

import (
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Maximum range we'll serve in one request. The brief names production rosters
// of up to two years of history as the ceiling; past that, the client is almost
// certainly asking for the wrong thing.
const maxWeeks = 104

// capacityResponse is the shape returned by GET /api/capacity.
//
// Weeks is a parallel array to each person's Allocated slice: Allocated[i] is
// the hours allocated for the week starting at Weeks[i]. Capacity (WeeklyHours)
// is scalar per person because that's the shape of the data in `people`.
// Keeps bandwidth to one float per cell plus one date per week.
type capacityResponse struct {
	Weeks  []string         `json:"weeks"`
	People []personCapacity `json:"people"`
}

type personCapacity struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	WeeklyHours float64   `json:"weekly_hours"`
	Allocated   []float64 `json:"allocated"`
}

// handleCapacity serves GET /api/capacity?from=YYYY-MM-DD&to=YYYY-MM-DD.
//
// Returns, for every person and every ISO week in the requested range, how
// many hours they are allocated and their weekly capacity. The range is
// snapped: `from` to the containing Monday, `to` to the following Sunday,
// so the grid always shows whole weeks.
func (s *server) handleCapacity(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Snap to ISO week boundaries (Monday-start). date_trunc('week', d) in
	// Postgres already does Monday-start, so this matches the server-side math.
	weekStart := snapToMonday(from)
	weekEnd := snapToSunday(to)

	weeks := (int(weekEnd.Sub(weekStart).Hours())/24 + 1) / 7
	if weeks > maxWeeks {
		http.Error(w, fmt.Sprintf("range too large: %d weeks (max %d)", weeks, maxWeeks), http.StatusBadRequest)
		return
	}

	// Assignments are narrowed to the requested range first (the
	// (start_date, end_date) index can serve this for narrow ranges), then each
	// is expanded into the weeks it overlaps. Allocation is summed per
	// (person, week) and joined onto people × weeks so every cell exists.
	// Overlap is inclusive on both ends, hence the + 1.
	const query = `
WITH weeks AS (
  SELECT generate_series($1::date, $2::date, interval '7 days')::date AS week_start
),
in_range AS (
  SELECT person_id, start_date, end_date, hours_per_day
  FROM assignments
  WHERE start_date <= $2::date
    AND end_date   >= $1::date
),
cells AS (
  -- Expand each assignment into only the weeks it overlaps (Mondays, clipped
  -- to the range), rather than testing every assignment against every week.
  SELECT
    a.person_id,
    wk.week_start,
    SUM(
      (LEAST(a.end_date, wk.week_start + 6) - GREATEST(a.start_date, wk.week_start) + 1)
      * a.hours_per_day
    ) AS allocated
  FROM in_range a
  CROSS JOIN LATERAL (
    SELECT generate_series(
      date_trunc('week', GREATEST(a.start_date, $1::date)),
      LEAST(a.end_date, $2::date),
      interval '7 days'
    )::date AS week_start
  ) wk
  GROUP BY a.person_id, wk.week_start
)
SELECT
  p.id,
  p.name,
  p.weekly_hours::float8,
  array_agg(COALESCE(c.allocated, 0)::float8 ORDER BY w.week_start) AS allocated
FROM people p
CROSS JOIN weeks w
LEFT JOIN cells c ON c.person_id = p.id AND c.week_start = w.week_start
GROUP BY p.id, p.name, p.weekly_hours
ORDER BY p.name, p.id;
`

	// The planner can't estimate the lateral generate_series, guesses 1000
	// rows per assignment, and the inflated cost trips JIT compilation —
	// ~250ms of compile for a query that runs in under 100ms at 104 weeks.
	// Scoped to this transaction, not the server.
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		internalError(w, "capacity begin", err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SET LOCAL jit = off`); err != nil {
		internalError(w, "capacity jit", err)
		return
	}

	rows, err := tx.Query(r.Context(), query, weekStart, weekEnd)
	if err != nil {
		internalError(w, "capacity query", err)
		return
	}
	defer rows.Close()

	// Non-nil so an empty roster encodes as [] rather than null.
	people := []personCapacity{}
	for rows.Next() {
		var p personCapacity
		if err := rows.Scan(&p.ID, &p.Name, &p.WeeklyHours, &p.Allocated); err != nil {
			internalError(w, "capacity scan", err)
			return
		}
		people = append(people, p)
	}
	if err := rows.Err(); err != nil {
		internalError(w, "capacity rows", err)
		return
	}

	// Weeks come from the snapped range, not from the first row, so they are
	// present even when there are no people.
	weekStrs := make([]string, 0, weeks)
	for d := weekStart; !d.After(weekEnd); d = d.AddDate(0, 0, 7) {
		weekStrs = append(weekStrs, d.Format("2006-01-02"))
	}

	writeJSON(w, http.StatusOK, capacityResponse{
		Weeks:  weekStrs,
		People: people,
	})
}

// parseRange validates the ?from=&to= query parameters. Both are required.
func parseRange(fromStr, toStr string) (time.Time, time.Time, error) {
	if fromStr == "" || toStr == "" {
		return time.Time{}, time.Time{}, errors.New("from and to are required (YYYY-MM-DD)")
	}
	from, err := time.Parse("2006-01-02", fromStr)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("invalid from: %w", err)
	}
	to, err := time.Parse("2006-01-02", toStr)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("invalid to: %w", err)
	}
	if to.Before(from) {
		return time.Time{}, time.Time{}, errors.New("to is before from")
	}
	return from, to, nil
}

// snapToMonday returns the Monday of the ISO week containing d.
func snapToMonday(d time.Time) time.Time {
	// Go's Weekday: Sunday=0, Monday=1, ..., Saturday=6.
	// We want to subtract (weekday-1) days, with Sunday treated as 7.
	wd := int(d.Weekday())
	if wd == 0 {
		wd = 7
	}
	return d.AddDate(0, 0, -(wd - 1))
}

// snapToSunday returns the Sunday that ends the ISO week containing d.
func snapToSunday(d time.Time) time.Time {
	return snapToMonday(d).AddDate(0, 0, 6)
}
