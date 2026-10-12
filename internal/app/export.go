package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"hashpad/internal/platform"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// exportKinds are the files Export can write (SPEC §7.3). The print view asks
// where a PDF goes through this same dialog (print.go).
var exportKinds = map[string]struct {
	filters []runtime.FileFilter
	ext     string
}{
	"html": {
		filters: []runtime.FileFilter{
			{DisplayName: "Web page (*.html)", Pattern: "*.html;*.htm"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
		ext: ".html",
	},
	"text": {
		filters: []runtime.FileFilter{
			{DisplayName: "Text (*.txt)", Pattern: "*.txt"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
		ext: ".txt",
	},
	"pdf": {
		filters: []runtime.FileFilter{
			{DisplayName: "PDF (*.pdf)", Pattern: "*.pdf"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
		ext: ".pdf",
	},
}

// ShowExportDialog returns "" if the user cancelled. The file itself is
// written with WriteFile, so an export is as atomic as a save.
func (a *App) ShowExportDialog(suggestedName, kind string) (string, error) {
	k, ok := exportKinds[kind]
	if !ok {
		return "", fmt.Errorf("export dialog: unknown kind %q", kind)
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export",
		DefaultFilename: suggestedName,
		Filters:         k.filters,
	})
	if err != nil {
		return "", fmt.Errorf("export dialog: %w", err)
	}

	// Same reason as ShowSaveDialog: Windows' dialog does not always append
	// the filter's extension.
	if path != "" && filepath.Ext(path) == "" {
		path += k.ext
	}
	return path, nil
}

// openExternal is a variable so the tests never start a browser.
var openExternal = platform.OpenExternal

// OpenURL opens a document's link, or the About dialog's, in the default
// browser. The scheme is checked here as well as in the preview: this is the
// trust boundary, and what is on the other side of it will open a local
// program as readily as a web page.
func (a *App) OpenURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("open url: %w", err)
	}
	// url.Parse lowercases the scheme, so HTTPS:// is accepted too.
	switch u.Scheme {
	case "http", "https", "mailto":
		return openExternal(u.String())
	default:
		return fmt.Errorf("open url: refusing scheme %q", u.Scheme)
	}
}

// OpenInBrowser writes html to a temporary page and opens it in the default
// browser. It is how a document's internet images reach a PDF: the browser
// fetches them, Hashpad never does (design §3).
//
// The one file Hashpad writes without a save dialog. Shutdown deletes it; a
// browser that has already loaded it keeps showing it.
func (a *App) OpenInBrowser(html string) error {
	f, err := os.CreateTemp("", "hashpad-print-*.html")
	if err != nil {
		return fmt.Errorf("open in browser: %w", err)
	}
	_, werr := f.WriteString(html)
	if err := errors.Join(werr, f.Close()); err != nil {
		os.Remove(f.Name())
		return fmt.Errorf("open in browser: %w", err)
	}

	// file:///C:/Users/... on Windows, file:///tmp/... elsewhere.
	p := filepath.ToSlash(f.Name())
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if err := openExternal((&url.URL{Scheme: "file", Path: p}).String()); err != nil {
		os.Remove(f.Name())
		return fmt.Errorf("open in browser: %w", err)
	}

	a.tempMu.Lock()
	a.tempFiles = append(a.tempFiles, f.Name())
	a.tempMu.Unlock()
	return nil
}

// Shutdown deletes the pages OpenInBrowser wrote and the print view's PDFs.
// Exported because Wails calls it from main, after the window is gone.
//
// A crash skips this; Startup's sweepPrintTemp clears what it left.
func (a *App) Shutdown(ctx context.Context) {
	a.tempMu.Lock()
	defer a.tempMu.Unlock()
	for _, p := range a.tempFiles {
		os.Remove(p)
	}
	a.tempFiles = nil
	removePrintDir()
}
