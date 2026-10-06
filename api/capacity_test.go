package main

import (
	"testing"
	"time"
)

// We don't have a running Postgres in unit tests, so we test the helpers that
// decide week boundaries. The SQL math is exercised live against the seed when
// `make up` is running.

func TestSnapToMonday(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"already monday", "2026-01-05", "2026-01-05"},
		{"tuesday", "2026-01-06", "2026-01-05"},
		{"sunday counts as end of prior week", "2026-01-04", "2025-12-29"},
		{"saturday", "2026-01-03", "2025-12-29"},
		{"year boundary", "2026-01-01", "2025-12-29"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in, _ := time.Parse("2006-01-02", c.in)
			got := snapToMonday(in).Format("2006-01-02")
			if got != c.want {
				t.Fatalf("snapToMonday(%s) = %s, want %s", c.in, got, c.want)
			}
		})
	}
}

func TestSnapToSunday(t *testing.T) {
	in, _ := time.Parse("2006-01-02", "2026-01-05")
	got := snapToSunday(in).Format("2006-01-02")
	if got != "2026-01-11" {
		t.Fatalf("snapToSunday(2026-01-05) = %s, want 2026-01-11", got)
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		name    string
		from    string
		to      string
		wantErr bool
	}{
		{"ok", "2026-01-05", "2026-02-01", false},
		{"missing from", "", "2026-02-01", true},
		{"missing to", "2026-01-05", "", true},
		{"to before from", "2026-02-01", "2026-01-05", true},
		{"garbage", "not-a-date", "2026-02-01", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := parseRange(c.from, c.to)
			if (err != nil) != c.wantErr {
				t.Fatalf("parseRange(%q,%q) err=%v wantErr=%v", c.from, c.to, err, c.wantErr)
			}
		})
	}
}

func TestValidateWeeklyHours(t *testing.T) {
	five := 5.0
	neg := -1.0
	huge := 999.0
	cases := []struct {
		name    string
		in      *float64
		wantErr bool
	}{
		{"missing", nil, true},
		{"ok", &five, false},
		{"negative", &neg, true},
		{"too large", &huge, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validateWeeklyHours(c.in)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateWeeklyHours err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
