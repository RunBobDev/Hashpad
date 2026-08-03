//go:build linux

package platform

// ConfineChildProcesses is a no-op on Linux.
//
// PLATFORM: the Windows implementation exists to work around a WebView2 defect
// that leaves half its process tree running after the window closes. WebKitGTK
// spawns its helpers into our process group, so they already die with us and
// there is nothing to confine. Returning nil rather than ErrNotImplemented is
// deliberate: nothing is missing here, so a caller logging a warning would be
// reporting a problem that does not exist.
func ConfineChildProcesses() error { return nil }
