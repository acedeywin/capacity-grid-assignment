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
	ID           int       `json:"id"`
	Name         string    `json:"name"`
	WeeklyHours  float64   `json:"weekly_hours"`
	Allocated    []float64 `json:"allocated"`
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

	// One pass over assignments, bucketed by week in Postgres. Index on
	// (start_date, end_date) carries the overlap predicate; the aggregation
	// stays in-engine.
	const query = `
WITH weeks AS (
  SELECT generate_series($1::date, $2::date, interval '7 days')::date AS week_start
),
cells AS (
  SELECT
    p.id AS person_id,
    w.week_start,
    COALESCE(SUM(
      GREATEST(
        0,
        (LEAST(a.end_date,   w.week_start + 6)::date
         - GREATEST(a.start_date, w.week_start)::date
         + 1)
      ) * a.hours_per_day
    ), 0)::float8 AS allocated
  FROM people p
  CROSS JOIN weeks w
  LEFT JOIN assignments a
    ON a.person_id = p.id
   AND a.start_date <= w.week_start + 6
   AND a.end_date   >= w.week_start
  GROUP BY p.id, w.week_start
)
SELECT
  p.id,
  p.name,
  p.weekly_hours::float8,
  array_agg(c.allocated   ORDER BY c.week_start) AS allocated,
  array_agg(c.week_start  ORDER BY c.week_start) AS weeks
FROM people p
JOIN cells c ON c.person_id = p.id
GROUP BY p.id, p.name, p.weekly_hours
ORDER BY p.name, p.id;
`

	rows, err := s.db.Query(r.Context(), query, weekStart, weekEnd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var people []personCapacity
	var weekDates []time.Time
	for rows.Next() {
		var p personCapacity
		var rowWeeks []time.Time
		if err := rows.Scan(&p.ID, &p.Name, &p.WeeklyHours, &p.Allocated, &rowWeeks); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if weekDates == nil {
			weekDates = rowWeeks
		}
		people = append(people, p)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	weekStrs := make([]string, len(weekDates))
	for i, d := range weekDates {
		weekStrs[i] = d.Format("2006-01-02")
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
