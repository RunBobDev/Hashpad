package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The print bridge reads two unexported Wails fields and a promoted method by
// reflection (print_windows.go). The type that holds them lives in an
// `internal` package Hashpad cannot import, so this reads the pinned Wails
// source instead: a Wails update that renames any of them fails here, before
// a release, rather than quietly falling back on users' machines.
func TestWailsStillHasWhatThePrintBridgeReads(t *testing.T) {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/wailsapp/wails/v2").Output()
	if err != nil {
		t.Fatalf("locate the Wails module: %v", err)
	}
	root := strings.TrimSpace(string(out))
	win := filepath.Join(root, "internal", "frontend", "desktop", "windows")

	for _, c := range []struct{ file, pattern string }{
		{filepath.Join(win, "frontend.go"), `\bchromium\s+\*edge\.Chromium\b`},
		{filepath.Join(win, "frontend.go"), `\bmainWindow\s+\*Window\b`},
		{filepath.Join(win, "window.go"), `type Window struct \{\s*winc\.Form\b`},
		{filepath.Join(win, "winc", "form.go"), `type Form struct \{\s*ControlBase\b`},
		{filepath.Join(win, "winc", "controlbase.go"), `func \(\w+ \*ControlBase\) Invoke\(f func\(\)\) bool`},
		{filepath.Join(root, "internal", "app", "app_production.go"), `context\.WithValue\(ctx, "frontend", appFrontend\)`},
	} {
		src, err := os.ReadFile(c.file)
		if err != nil {
			t.Errorf("read %s: %v", c.file, err)
			continue
		}
		if !regexp.MustCompile(c.pattern).Match(src) {
			t.Errorf("%s no longer matches %s -- update print_windows.go before this Wails version ships", c.file, c.pattern)
		}
	}
}
