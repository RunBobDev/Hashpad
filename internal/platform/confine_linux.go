//go:build linux

package platform

import (
	"fmt"
	"os/exec"
)

// ConfineChildProcesses is a no-op on Linux.
//
// PLATFORM: the Windows implementation exists to work around a WebView2 defect
// that leaves half its process tree running after the window closes. WebKitGTK
// spawns its helpers into our process group, so they already die with us and
// there is nothing to confine. Returning nil rather than ErrNotImplemented is
// deliberate: nothing is missing here, so a caller logging a warning would be
// reporting a problem that does not exist.
func ConfineChildProcesses() error { return nil }

// OpenExternal hands target to the desktop's default handler.
//
// PLATFORM: no job to escape here -- see ConfineChildProcesses. Untested on a
// Linux desktop so far, like the rest of this file.
func OpenExternal(target string) error {
	cmd := exec.Command("xdg-open", target)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open %s: %w", target, err)
	}
	// Reaped in the background so it does not linger as a zombie.
	go func() { _ = cmd.Wait() }()
	return nil
}
