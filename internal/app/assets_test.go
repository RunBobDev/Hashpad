package app

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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

	a := New()
	a.SetActiveDocumentDir(dir)
	handler := AssetHandler(a)

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
			req := httptest.NewRequest(http.MethodGet, "/__hashpad/asset?path="+urlEscape(tc.path), nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("path %q: got %d, want %d", tc.path, rec.Code, tc.want)
			}
		})
	}
}

func TestAssetHandlerWithNoActiveDocument(t *testing.T) {
	a := New()
	a.SetActiveDocumentDir("")
	req := httptest.NewRequest(http.MethodGet, "/__hashpad/asset?path=x.png", nil)
	rec := httptest.NewRecorder()
	AssetHandler(a).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("unsaved document: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func urlEscape(s string) string {
	return (&url.URL{Path: s}).EscapedPath()
}
