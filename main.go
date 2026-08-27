package main

import (
	"embed"
	"log"
	"os"

	"hashpad/internal/app"
	"hashpad/internal/platform"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// singleInstanceID names the lock that makes a second launch hand its files to
// the first (SPEC §6.4). The value is arbitrary but must never change: Wails
// derives a mutex name and a window class from it, so a different string is a
// different application as far as the lock is concerned, and two builds that
// disagree would happily run side by side.
//
// PLATFORM: Windows uses a named mutex and a message-only window; Linux uses a
// lock file under the user's runtime directory. Wails picks per platform, so
// this one constant serves both.
const singleInstanceID = "hashpad-8f3a1c62-5d94-4b0e-9a7f-2c6e1d0b4a83"

func main() {
	// Before the webview exists, so every process it spawns inherits the job.
	// WebView2 leaves roughly half its process tree running after the window
	// closes -- a documented WebView2 defect, not something the host can ask it
	// not to do -- and those orphans accumulate across launches. Not fatal if it
	// fails: the app works fine, it just leaks the way it did before.
	if err := platform.ConfineChildProcesses(); err != nil {
		log.Printf("hashpad: could not confine child processes (%v); "+
			"webview processes may outlive the app", err)
	}

	application := app.New()

	// The files this launch was asked to open (SPEC §6.4), collected before
	// wails.Run because Explorer's double-click arrives as an argument and
	// there is no other moment to read it.
	//
	// os.Getwd's error is deliberately ignored: an empty cwd leaves relative
	// arguments relative, and the os.Stat inside resolves them against the
	// process's working directory — which is the answer os.Getwd failed to give.
	cwd, _ := os.Getwd()
	application.OpenFromCommandLine(os.Args[1:], cwd)

	err := wails.Run(&options.App{
		Title:  "Hashpad",
		Width:  1000,
		Height: 700,
		AssetServer: &assetserver.Options{
			Assets: assets,
			// Relative image paths in the preview resolve here (design §5.7).
			// Wails calls this for any GET the embedded assets cannot serve.
			// app.AssetHandler is a package-level function, not a bound
			// method -- see its doc comment for why that distinction matters.
			Handler: app.AssetHandler(),
		},
		// SPEC §6.1 draws the menu bar and window controls on one row, which a
		// native OS frame/menu cannot do, so the window is frameless and the
		// chrome is HTML (frontend/src/ui/menubar.ts).
		Frameless: true,
		MinWidth:  480,
		MinHeight: 320,
		// SPEC §6.4: dropping a file on the window opens it in a tab. This has
		// to come from Wails rather than a DOM `drop` listener, because the
		// webview hands JavaScript `File` objects with no filesystem path --
		// browsers withhold it deliberately, and there is nothing to open
		// without it. Wails resolves the real paths natively (on Windows via
		// WebView2's postMessageWithAdditionalObjects) and hands them to
		// frontend/src/ui/filedrop.ts.
		//
		// `DisableWebViewDrop` stays false: the webview must still receive the
		// event, since that is how the frontend hears about it at all.
		DragAndDrop: &options.DragAndDrop{EnableFileDrop: true},
		// Opaque white so the window does not flash a dark frame before CSS
		// applies. Go cannot read CSS, so this is the single sanctioned
		// exception to "colours only live in variables.css".
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255},
		// The theme is not known at first paint -- settings arrive over IPC,
		// and CSP's script-src 'self' forbids the inline bootstrap script
		// that would otherwise pick a theme before anything renders. So the
		// window starts hidden and frontend/src/main.ts calls WindowShow once
		// it has applied a theme, on every path (including failure ones).
		StartHidden:   true,
		OnStartup:     application.Startup,
		OnBeforeClose: application.OnBeforeClose,
		// SPEC §6.4: double-clicking a .md in Explorer must reach the window
		// that is already open rather than start a second Hashpad. Wails takes
		// the lock, exits the second process, and forwards its arguments here.
		//
		// Wrapped in a closure rather than pointing at a method with this
		// signature, so `internal/app` never imports Wails' options package —
		// and so the bound method it does expose takes two plain arguments
		// instead of putting a Wails struct into the generated TypeScript.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: singleInstanceID,
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				application.OpenFromCommandLine(data.Args, data.WorkingDirectory)
			},
		},
		Bind: []interface{}{application},
	})
	if err != nil {
		// wails.Run only returns on failure to start (for example, the webview
		// could not be created). There is no window to show an error in, so
		// stderr and a non-zero exit are all that is left.
		log.Fatal("hashpad: ", err)
	}
}
