//go:build windows

package platform

// PLATFORM: Windows implementation. Bodies land in Checkpoint D (theme) and
// Checkpoint G (reveal in file manager); the type exists now so the seam is
// real from the first commit.

type windowsPlatform struct{}

// Current returns the platform implementation for this OS.
func Current() Platform { return &windowsPlatform{} }

func (p *windowsPlatform) SystemThemeIsDark() (bool, error) {
	return false, ErrNotImplemented
}

func (p *windowsPlatform) OnSystemThemeChange(fn func(isDark bool)) (func(), error) {
	return func() {}, ErrNotImplemented
}

func (p *windowsPlatform) ShowInFileManager(path string) error {
	return ErrNotImplemented
}
