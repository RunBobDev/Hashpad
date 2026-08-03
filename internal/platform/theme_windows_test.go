//go:build windows

package platform

import "testing"

// AppsUseLightTheme is 1 for light and 0 for dark — the name reads as the
// opposite of what callers want, which is exactly why this mapping is worth
// pinning down rather than inlining.
func TestAppsUseLightThemeToDark(t *testing.T) {
	tests := []struct {
		name  string
		value uint64
		want  bool
	}{
		{name: "zero means dark", value: 0, want: true},
		{name: "one means light", value: 1, want: false},
		// Windows has only ever written 0 or 1, but a corrupt or future value
		// must not read as dark — light is the safer default because the app's
		// own default background is light.
		{name: "unexpected value is not dark", value: 2, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := appsUseLightThemeToDark(tt.value); got != tt.want {
				t.Errorf("appsUseLightThemeToDark(%d) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}
