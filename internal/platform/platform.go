// Package platform isolates every OS-specific behaviour behind one interface.
// When Linux support arrives the work is implementing one file, not auditing
// the codebase (SPEC §5.2).
package platform

import "errors"

// ErrNotImplemented is returned by stubs on platforms that have no
// implementation yet. Callers must degrade gracefully rather than fail.
var ErrNotImplemented = errors.New("platform: not implemented on this OS")

type Platform interface {
	// SystemThemeIsDark reports the OS colour preference. Returns an error when
	// undeterminable rather than guessing — callers fall back to the user's
	// manual setting (SPEC §6.12).
	SystemThemeIsDark() (bool, error)

	// OnSystemThemeChange registers fn for live theme-change notifications and
	// returns a function that stops watching.
	OnSystemThemeChange(fn func(isDark bool)) (stop func(), err error)

	// ShowInFileManager reveals path in the OS file manager.
	ShowInFileManager(path string) error

	// InstalledFonts lists the installed font families text can use, sorted,
	// for the settings dialog's font dropdowns. An error means "no list": the
	// dialog falls back to text fields.
	InstalledFonts() ([]Font, error)
}

// Font is an installed font family, as the settings dropdowns list it.
type Font struct {
	Name string `json:"name"`
	// Every glyph the same width: the editor's dropdown lists these first.
	Monospaced bool `json:"monospaced"`
}
