//go:build !windows

package app

import "errors"

// PLATFORM: the print view's engine calls are Windows-only (print_windows.go).
// Elsewhere File > Print opens the standard dialog.
var errPrintUnsupported = errors.New("print view: not available on this platform")

func enginePrintToPdf(*App, string, float64, float64) error { return errPrintUnsupported }
func engineShowPrintUI(*App) error                          { return errPrintUnsupported }
func engineProbe(*App) error                                { return errPrintUnsupported }
