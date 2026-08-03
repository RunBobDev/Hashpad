package app

import "hashpad/internal/platform"

// SystemThemeIsDark reports the OS colour preference. It is called at startup
// and again on every window focus — there is no live watcher (see
// platform.Platform.OnSystemThemeChange) — so this stays a thin, stateless
// delegate rather than caching anything on App.
//
// Errors are not fatal: they propagate to the frontend, which treats an error
// as "undeterminable" and falls back to the user's manual setting rather than
// guessing at light or dark (SPEC §6.12).
func (a *App) SystemThemeIsDark() (bool, error) {
	return platform.Current().SystemThemeIsDark()
}
