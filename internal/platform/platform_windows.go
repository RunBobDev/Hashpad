//go:build windows

package platform

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// PLATFORM: Windows implementation. Bodies land in Checkpoint D (theme) and
// Checkpoint G (reveal in file manager); the type exists now so the seam is
// real from the first commit.

type windowsPlatform struct{}

// Current returns the platform implementation for this OS.
func Current() Platform { return &windowsPlatform{} }

// PLATFORM: Windows stores the app colour preference here. The value is named
// for light rather than dark, so read it through appsUseLightThemeToDark
// rather than coercing it directly.
const (
	personalizeKey  = `SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize`
	appsUseLightVal = "AppsUseLightTheme"
)

// appsUseLightThemeToDark maps the registry value to "is dark". Anything other
// than 0 is treated as light, because the app's own default background is
// light and a corrupt value should not darken the whole UI.
func appsUseLightThemeToDark(value uint64) bool { return value == 0 }

func (p *windowsPlatform) SystemThemeIsDark() (bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, personalizeKey, registry.QUERY_VALUE)
	if err != nil {
		return false, fmt.Errorf("open %s: %w", personalizeKey, err)
	}
	defer key.Close()

	value, _, err := key.GetIntegerValue(appsUseLightVal)
	if err != nil {
		// Missing on some Server SKUs and heavily customised images. That is
		// "undeterminable", not a crash — the caller falls back to the user's
		// manual setting (SPEC §6.12).
		return false, fmt.Errorf("read %s: %w", appsUseLightVal, err)
	}
	return appsUseLightThemeToDark(value), nil
}

// OnSystemThemeChange is deliberately still unimplemented. Watching the key
// means a blocking RegNotifyChangeKeyValue in a goroutine with an event handle
// to create, signal and close -- the riskiest code in this checkpoint, for a
// case the frontend covers almost entirely by re-reading on window focus. The
// method stays on the interface so filling it in later is one body, not a
// restructure.
func (p *windowsPlatform) OnSystemThemeChange(fn func(isDark bool)) (func(), error) {
	return func() {}, ErrNotImplemented
}

func (p *windowsPlatform) ShowInFileManager(path string) error {
	return ErrNotImplemented
}
