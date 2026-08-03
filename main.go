package main

import (
	"embed"
	"log"

	"hashpad/internal/app"
	"hashpad/internal/platform"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

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

	err := wails.Run(&options.App{
		Title:  "Hashpad",
		Width:  1000,
		Height: 700,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// SPEC §6.1 draws the menu bar and window controls on one row, which a
		// native OS frame/menu cannot do, so the window is frameless and the
		// chrome is HTML (frontend/src/ui/menubar.ts).
		Frameless: true,
		MinWidth:  480,
		MinHeight: 320,
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
		Bind:          []interface{}{application},
	})
	if err != nil {
		// wails.Run only returns on failure to start (for example, the webview
		// could not be created). There is no window to show an error in, so
		// stderr and a non-zero exit are all that is left.
		log.Fatal("hashpad: ", err)
	}
}
