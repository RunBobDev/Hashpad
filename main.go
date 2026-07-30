package main

import (
	"embed"
	"log"

	"hashpad/internal/app"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
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
		OnStartup:        application.Startup,
		OnBeforeClose:    application.OnBeforeClose,
		Bind:             []interface{}{application},
	})
	if err != nil {
		// wails.Run only returns on failure to start (for example, the webview
		// could not be created). There is no window to show an error in, so
		// stderr and a non-zero exit are all that is left.
		log.Fatal("hashpad: ", err)
	}
}
