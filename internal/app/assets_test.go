package app

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAssetHandler(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "assets")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nested, "pic.png"), []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	handler := AssetHandler()

	cases := []struct {
		name string
		path string
		want int
	}{
		{"a valid nested image", "assets/pic.png", http.StatusOK},
		{"a missing file", "assets/gone.png", http.StatusNotFound},
		{"parent traversal", "../outside.png", http.StatusForbidden},
		{"nested parent traversal", "assets/../../outside.png", http.StatusForbidden},
		{"a windows-style traversal", `..\outside.png`, http.StatusForbidden},
		{"an absolute unix path", "/etc/passwd", http.StatusForbidden},
		{"a drive-relative windows path", "C:outside.png", http.StatusForbidden},
		{"an absolute windows path", `C:\Windows\win.ini`, http.StatusForbidden},
		{"a UNC path", `\\server\share\x.png`, http.StatusForbidden},
		// The route serves images, not files. Without this it is a general
		// local-file reader reachable from any document the user opens.
		{"a non-image extension inside the directory", "secret.txt", http.StatusForbidden},
		{"no path parameter", "", http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, assetRequest(dir, tc.path))
			if rec.Code != tc.want {
				t.Errorf("path %q: got %d, want %d", tc.path, rec.Code, tc.want)
			}
		})
	}
}

// The one input an attacker controls is the document's `src`, and it reaches
// the URL through encodeURIComponent, which escapes `&` and `=` -- so a src of
// `foo.png&dir=C:\Windows&path=win.ini` arrives whole inside the `path` value
// instead of adding a second `dir` key.
//
// That the escaping holds is asserted where the escaping happens, in
// preview/rules/rules.test.ts ("cannot have its dir overridden by a hostile
// src"); asserting it again here would only be testing net/url. This is the
// other half: what arrives is refused rather than served.
//
// It is the extension allow-list that refuses this one, on the trailing
// `.ini`. Worth knowing where the line actually falls: the same src ending
// `.png` passes the allow-list and is looked up as a literal filename inside
// the *real* directory, which on Windows returns 500 rather than 404 because
// the `:` makes it an illegal name (measured, this machine). Still contained,
// still nothing served -- but it is the containment checks doing that work,
// not the allow-list.
func TestAssetHandlerRejectsAnInjectedDirectory(t *testing.T) {
	rec := httptest.NewRecorder()
	AssetHandler().ServeHTTP(rec, assetRequest(t.TempDir(), `foo.png&dir=C:\Windows&path=win.ini`))

	if rec.Code != http.StatusForbidden {
		t.Errorf("got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// A drive-relative directory is the shape a document saved at a drive root
// produces, and it is not merely refused-out-of-caution: filepath.Join("C:",
// "x.png") yields "C:x.png", which the OS resolves against the process working
// directory, while filepath.Rel("C:", "C:x.png") returns "x.png" so every
// containment check below still passes. Measured before the guard: a request
// served a file from the repository folder rather than the document's.
func TestAssetHandlerRejectsARelativeDirectory(t *testing.T) {
	for _, dir := range []string{"C:", "relative/dir", "."} {
		t.Run(dir, func(t *testing.T) {
			rec := httptest.NewRecorder()
			AssetHandler().ServeHTTP(rec, assetRequest(dir, "pic.png"))
			if rec.Code != http.StatusForbidden {
				t.Errorf("dir %q: got %d, want %d", dir, rec.Code, http.StatusForbidden)
			}
		})
	}
}

// An SVG is a document, not just a picture, and it is served from the app's own
// origin. index.html's CSP is a <meta> tag, which does not apply to a page the
// webview navigates to -- so these headers are what stop a linked
// `evil.svg` running script where Wails' bound methods are reachable.
func TestAssetHandlerSendsSecurityHeaders(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pic.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	rec := httptest.NewRecorder()
	AssetHandler().ServeHTTP(rec, assetRequest(dir, "pic.svg"))

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "default-src 'none'; sandbox" {
		t.Errorf("CSP: got %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("nosniff: got %q", got)
	}
}

func TestAssetHandlerWithNoActiveDocument(t *testing.T) {
	rec := httptest.NewRecorder()
	AssetHandler().ServeHTTP(rec, assetRequest("", "x.png"))
	if rec.Code != http.StatusForbidden {
		t.Errorf("unsaved document: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// Both values escaped the way rules/images.ts escapes them -- encodeURIComponent
// per value, which is what makes a `&` inside either one inert.
func assetRequest(dir, path string) *http.Request {
	q := url.Values{"dir": {dir}, "path": {path}}
	return httptest.NewRequest(http.MethodGet, assetRoute+"?"+q.Encode(), nil)
}

// TestFilepathIsLocalOnDeviceNames pins the *premise* AssetHandler's containment
// check rests on, rather than the handler itself.
//
// It exists because the note that scheduled this change was wrong. The ledger
// said `filepath.IsLocal` rejects "Windows device names (NUL)", full stop, and
// that belief was carried for two checkpoints. It rejects the **bare** name and
// accepts `NUL.png`. The handler's comment now says so; this is what will fail
// if a future Go moves the line either way, so the comment cannot quietly rot
// into another wrong claim.
func TestFilepathIsLocalOnDeviceNames(t *testing.T) {
	if runtime.GOOS != "windows" {
		// `NUL` is an ordinary filename everywhere else, so IsLocal is true for
		// all of these and the cases below assert nothing.
		t.Skip("device names are a Windows concept")
	}

	rejected := []string{"NUL", "nul", "CON", "COM1", "LPT1", "AUX", "PRN"}
	for _, name := range rejected {
		if filepath.IsLocal(name) {
			t.Errorf("IsLocal(%q) = true; a bare device name must not be treated as a local path", name)
		}
	}

	// Accepted, and this is the half the old note missed. Left as an assertion
	// rather than a comment so the day it changes is a failing test and not a
	// surprise.
	accepted := []string{"NUL.png", "COM1.png", "assets/NUL.png"}
	for _, name := range accepted {
		if !filepath.IsLocal(name) {
			t.Errorf("IsLocal(%q) = false; the handler's comment says this reaches os.Open, "+
				"and if that is no longer true the comment needs rewriting", name)
		}
	}
}

// TestAssetHandlerRefusesDeviceNames covers what the suite had nothing for at
// all: a request naming a Windows device rather than a file.
//
// `os.Open("COM1")` is an open serial port, and a read on one can block --
// which in this handler means a request that never returns. Nothing here was
// testing that, and the protection was split across two layers by accident
// rather than design: the extension allow-list happened to refuse the bare
// forms, and `os.Open` happened to refuse the dotted ones.
func TestAssetHandlerRefusesDeviceNames(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("device names are a Windows concept")
	}

	dir := t.TempDir()
	handler := AssetHandler()

	// Bare names, refused before any filesystem call.
	//
	// **Two layers refuse these, and no test can tell them apart**: since H.9
	// `filepath.IsLocal` rejects them, and the extension allow-list rejected
	// them before that and still would -- a device name has no image extension.
	// Reverting the `IsLocal` line leaves this test green, which was measured.
	// That is not a hole in the case: what is worth pinning is that the route
	// refuses them at all, which nothing tested before this existed.
	for _, name := range []string{"NUL", "nul", "CON", "COM1", "LPT1", "AUX"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, assetRequest(dir, name))
		if rec.Code != http.StatusForbidden {
			t.Errorf("path %q: got %d, want %d", name, rec.Code, http.StatusForbidden)
		}
	}

	// Dotted forms, which `IsLocal` accepts (see the test above) and which
	// therefore run the whole handler and reach `os.Open`.
	//
	// **This is a tripwire, not a proof.** None of these files exists, so 404 is
	// over-determined -- it is what a missing file returns too. What the case
	// pins is the outcome that matters: the route never *serves* one. If a
	// future Go stops refusing device names, `NUL.png` becomes an empty 200 and
	// this fails; and if `COM1.png` ever opens a serial port, the read blocks
	// and this times out. Either way the day it changes is loud.
	for _, name := range []string{"NUL.png", "CON.png", "COM1.png", "assets/NUL.png"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, assetRequest(dir, name))
		if rec.Code == http.StatusOK {
			t.Errorf("path %q: got 200; a device name must never be served", name)
		}
		if rec.Code != http.StatusNotFound {
			t.Errorf("path %q: got %d, want %d", name, rec.Code, http.StatusNotFound)
		}
	}
}
