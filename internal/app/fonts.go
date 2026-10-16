package app

import "hashpad/internal/platform"

// InstalledFonts lists the installed font families for the settings dialog's
// font dropdowns (design §4.37). An error leaves the dialog's text fields.
func (a *App) InstalledFonts() ([]string, error) {
	return platform.Current().InstalledFonts()
}
