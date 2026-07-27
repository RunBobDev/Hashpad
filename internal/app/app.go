// Package app holds the methods bound to the frontend. It owns filesystem and
// OS concerns only; markdown semantics live entirely in the frontend (SPEC §3.1).
package app

import "context"

// App is the receiver for every method exposed to the frontend.
type App struct {
	ctx context.Context
}

// New creates the application struct.
func New() *App {
	return &App{}
}

// Startup stores the Wails context, which the runtime methods require.
// Exported because Wails calls it from main.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
}
