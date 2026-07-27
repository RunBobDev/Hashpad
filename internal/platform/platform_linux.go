//go:build linux

package platform

// PLATFORM: Linux stubs. These compile and return ErrNotImplemented so the
// interface cannot drift while Windows is the only real target (SPEC §5.2).

type linuxPlatform struct{}

// Current returns the platform implementation for this OS.
func Current() Platform { return &linuxPlatform{} }

func (p *linuxPlatform) SystemThemeIsDark() (bool, error) {
	return false, ErrNotImplemented
}

func (p *linuxPlatform) OnSystemThemeChange(fn func(isDark bool)) (func(), error) {
	return func() {}, ErrNotImplemented
}

func (p *linuxPlatform) ShowInFileManager(path string) error {
	return ErrNotImplemented
}
