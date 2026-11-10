// Package migrations embeds the SQL migrations applied with goose (ADR 0007).
package migrations

import "embed"

// FS holds every migration file.
//
//go:embed *.sql
var FS embed.FS
