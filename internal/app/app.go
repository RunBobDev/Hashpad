// Package app holds the methods bound to the frontend. It owns filesystem and
// OS concerns only; markdown semantics live entirely in the frontend (SPEC §3.1).
package app

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the receiver for every method exposed to the frontend.
type App struct {
	ctx context.Context

	// quitApproved is set by ConfirmQuit once the frontend has resolved every
	// dirty document. See OnBeforeClose for why this exists.
	quitApproved bool
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

// OnBeforeClose vetoes the first close request and asks the frontend to run the
// save prompts. The frontend calls ConfirmQuit once the user has decided, which
// sets the flag so the next close goes through. Without the flag the app could
// never close at all.
//
// This has to be split across two calls because OnBeforeClose is synchronous
// and returns a bool, while the Save/Don't Save/Cancel prompts it must wait on
// are asynchronous and live entirely in the frontend (SPEC §6.3).
func (a *App) OnBeforeClose(ctx context.Context) bool {
	if a.quitApproved {
		return false
	}
	runtime.EventsEmit(ctx, "app:close-requested")
	return true
}

// ConfirmQuit is called by the frontend once every dirty document has been
// resolved. It is a separate bound method rather than a return value because
// the decision is asynchronous and OnBeforeClose is not.
func (a *App) ConfirmQuit() {
	a.quitApproved = true
	runtime.Quit(a.ctx)
}
