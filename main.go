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
		OnStartup: application.Startup,
		Bind:      []interface{}{application},
	})
	if err != nil {
		// wails.Run only returns on failure to start (for example, the webview
		// could not be created). There is no window to show an error in, so
		// stderr and a non-zero exit are all that is left.
		log.Fatal("hashpad: ", err)
	}
}
