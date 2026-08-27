package app

import (
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// openFilesEvent hands paths to a window that is already up. Paths arriving
// before there is a window are queued for PendingFiles instead; see
// OpenFromCommandLine for the branch and why it is not a rare one.
const openFilesEvent = "app:open-files"

// OpenFromCommandLine takes the paths a launch was asked to open.
//
// Both launches come through here. main calls it with this process's own
// arguments before wails.Run, and Wails calls it again — through
// SingleInstanceLock — whenever someone starts Hashpad while it is already
// running (SPEC §6.4). The two differ only in whether there is a window yet,
// which is precisely the branch below, so there is one implementation rather
// than a startup path and a second-instance path that must be kept in step.
//
// `cwd` is the directory the *caller* was invoked from, not ours. A second
// instance started from a shell reports its own working directory, and a
// relative argument means nothing without it.
func (a *App) OpenFromCommandLine(args []string, cwd string) {
	paths := resolveFileArgs(args, cwd)

	ctx := a.startupContext()
	if ctx == nil {
		// No window yet, so there is nothing to emit an event to.
		//
		// This is the ordinary case for our own launch — main calls this before
		// wails.Run — and a genuinely reachable one for a second launch. Wails
		// creates the hidden window that receives these messages at the *top*
		// of Frontend.Run (SetupSingleInstance) and dispatches OnStartup, which
		// is what sets our context, from a goroutine at the *bottom*. The whole
		// of WebView2's initialisation sits between the two. Double-click a
		// second file while Hashpad is still starting and it arrives here, with
		// a nil context that would panic the running app on first use.
		//
		// Queued rather than dropped: a file the user double-clicked that
		// silently fails to open is the worst outcome available, and the
		// frontend is about to ask for exactly this list anyway.
		a.queueFiles(paths)
		return
	}

	// Raised first, and whether or not any paths survived: someone who launches
	// Hashpad again has asked to see Hashpad, even if they did it with no file.
	// Both calls are needed — a minimised window is already "shown" as far as
	// WindowShow is concerned, so without the unminimise the second launch
	// would leave it on the taskbar and look like nothing happened.
	runtime.WindowUnminimise(ctx)
	runtime.WindowShow(ctx)

	if len(paths) > 0 {
		runtime.EventsEmit(ctx, openFilesEvent, paths)
	}
}

// PendingFiles hands the frontend every queued path and forgets them.
//
// A pull rather than a push, because at startup there is nobody to push to: the
// frontend's JavaScript subscribes to events well after Go is ready, and an
// event emitted into that gap reaches no one. The frontend asks for these once
// its editor exists (frontend/src/files/openwith.ts).
//
// Draining is what makes a second call empty, and that matters — this is not
// the only route in. Anything arriving after the frontend is listening comes
// through openFilesEvent instead, so a list that survived the pull would be
// opened a second time.
func (a *App) PendingFiles() []string {
	a.pendingMu.Lock()
	defer a.pendingMu.Unlock()

	paths := a.pendingFiles
	a.pendingFiles = nil
	if paths == nil {
		// A nil slice marshals to JSON `null`, which would reach the frontend
		// as a value it has to defend against before it can filter it. An empty
		// list is the honest answer to "what is waiting" anyway.
		return []string{}
	}
	return paths
}

// queueFiles appends to the list PendingFiles will drain. Locked because the
// two callers are different goroutines: main's own launch runs before wails.Run
// on the main goroutine, and a second instance arrives on the goroutine Wails
// pumps its single-instance messages from.
func (a *App) queueFiles(paths []string) {
	if len(paths) == 0 {
		return
	}

	a.pendingMu.Lock()
	a.pendingFiles = append(a.pendingFiles, paths...)
	a.pendingMu.Unlock()
}

// resolveFileArgs turns command-line arguments into absolute paths worth
// opening, and drops everything else.
//
// Only regular files survive, which removes flags, directories and typos under
// one rule rather than a list of exclusions — `hashpad.exe --version` names no
// file, so there is nothing there to open. Which *kinds* of file Hashpad edits
// is deliberately not decided here: SPEC §6.4's extension list belongs to the
// frontend (ui/filedrop.ts), so a command line and a drop answer that question
// with the same code, once.
func resolveFileArgs(args []string, cwd string) []string {
	paths := make([]string, 0, len(args))

	for _, arg := range args {
		// No `arg == ""` guard here, and its absence is deliberate. Wails'
		// single-instance payload can carry an empty string, and one was
		// written for it — but mutation testing removed it and nothing broke,
		// because it could not: Join(cwd, "") is cwd, a directory, which the
		// IsRegular check below already drops, and with an empty cwd it is ""
		// again, which os.Stat rejects outright.
		path := arg
		if !filepath.IsAbs(path) {
			// Join cleans as it goes, so `..\notes\a.md` resolves against cwd
			// rather than being handed on with the parent segment still in it.
			// An empty cwd — os.Getwd failed — leaves the path relative, and
			// os.Stat below then resolves it against the process's working
			// directory, which is the answer os.Getwd could not give.
			path = filepath.Join(cwd, path)
		}

		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}

		paths = append(paths, path)
	}

	return paths
}
