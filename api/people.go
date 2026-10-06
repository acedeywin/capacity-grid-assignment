package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
)

type updatePersonRequest struct {
	WeeklyHours *float64 `json:"weekly_hours"`
}

type personResponse struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	WeeklyHours float64 `json:"weekly_hours"`
}

// handleUpdatePerson serves PATCH /api/people/{id}.
//
// Updates the person's weekly capacity. Returns the updated row so the client
// doesn't have to re-parse what it sent. Validation is minimal and explicit:
// weekly_hours must be present, finite, and non-negative.
func (s *server) handleUpdatePerson(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id <= 0 {
		http.Error(w, "invalid person id", http.StatusBadRequest)
		return
	}

	var req updatePersonRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateWeeklyHours(req.WeeklyHours); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var out personResponse
	err = s.db.QueryRow(
		r.Context(),
		`UPDATE people
		    SET weekly_hours = $1
		  WHERE id = $2
	      RETURNING id, name, weekly_hours::float8`,
		*req.WeeklyHours, id,
	).Scan(&out.ID, &out.Name, &out.WeeklyHours)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, "person not found", http.StatusNotFound)
			return
		}
		internalError(w, "update person", err)
		return
	}

	writeJSON(w, http.StatusOK, out)
}

func validateWeeklyHours(hrs *float64) error {
	if hrs == nil {
		return errors.New("weekly_hours is required")
	}
	// NaN and +/-Inf fail this comparison because any comparison with NaN
	// is false; -Inf < 0 is true. Either way, rejected.
	if !(*hrs >= 0 && *hrs <= 24*7) {
		return errors.New("weekly_hours must be between 0 and 168")
	}
	return nil
}
