// Package app holds the methods bound to the frontend. It owns filesystem and
// OS concerns only; markdown semantics live entirely in the frontend (SPEC §3.1).
package app

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// showWindowFallbackDelay bounds how long the window may stay hidden waiting for
// the frontend to theme itself. Long enough that a normal start always wins the
// race and this never fires; short enough that a broken start is not mistaken
// for the app failing to launch.
const showWindowFallbackDelay = 3 * time.Second

// App is the receiver for every method exposed to the frontend.
type App struct {
	ctx context.Context

	// quitApproved is set by ConfirmQuit once the frontend has resolved every
	// dirty document. See OnBeforeClose for why this exists.
	quitApproved bool

	// windowShown records whether the frontend reached ShowWindow. Read from
	// the backstop goroutine and written from an IPC handler, so it needs the
	// mutex; see showWindowEventually.
	windowMu    sync.Mutex
	windowShown bool
}

// New creates the application struct.
func New() *App {
	return &App{}
}

// Startup stores the Wails context, which the runtime methods require.
// Exported because Wails calls it from main.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	go a.showWindowEventually()
}

// ShowWindow reveals the window, which starts hidden so the frontend can paint
// it in the right theme before it is ever seen. Bound rather than letting the
// frontend call the runtime's WindowShow directly, so Go can tell a normal
// start from a frontend that never got this far -- see showWindowEventually.
func (a *App) ShowWindow() {
	a.windowMu.Lock()
	a.windowShown = true
	a.windowMu.Unlock()

	runtime.WindowShow(a.ctx)
}

// showWindowEventually is the backstop for StartHidden.
//
// If the frontend never reaches ShowWindow -- a bundle that fails to parse, a
// CSP violation blocking the script, a throw before bootstrap runs -- the
// window would stay hidden forever, which is indistinguishable from the app
// failing to launch. A visibly broken app beats an apparently absent one.
//
// On every normal start the frontend wins this race and the goroutine exits
// having done nothing.
func (a *App) showWindowEventually() {
	time.Sleep(showWindowFallbackDelay)

	a.windowMu.Lock()
	shown := a.windowShown
	a.windowMu.Unlock()
	if shown {
		return
	}

	log.Printf("hashpad: frontend did not show the window within %s; showing it anyway",
		showWindowFallbackDelay)
	runtime.WindowShow(a.ctx)
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
