package app

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// The print view's PDFs (design §4.34). The engine writes the document to at
// most two files, in one temporary folder per session:
//
//	preview.pdf -- no title, date or numbers; the view draws those on screen
//	final.pdf   -- the same pages with them; what Save writes
//
// Served same-origin at printRoute, so the CSP's connect-src 'self' covers
// the fetch, and no file path ever comes from the request.

const printRoute = "/__hashpad/print/"

// printTempPattern names the folder. OpenInBrowser's pages share the prefix,
// so sweepPrintTemp clears both after a crash.
const printTempPattern = "hashpad-print-*"

var printKinds = map[string]bool{"preview": true, "final": true}

// paperInches is width and height, portrait. The engine takes inches and
// ignores the CSS page size, so this is where paper is actually chosen.
var paperInches = map[string][2]float64{
	"a4":     {210 / 25.4, 297 / 25.4},
	"letter": {8.5, 11},
}

// The engine calls, swapped out by the tests. print_windows.go and
// print_other.go define them.
var (
	printToPdf  = enginePrintToPdf
	showPrintUI = engineShowPrintUI
	printProbe  = engineProbe
)

var (
	// printJobs keeps the engine to one job at a time: two prints, or a print
	// and the dialog, would share its one webview.
	printJobs sync.Mutex

	// printMu guards printDir and printVersion, which the route handler reads
	// on Wails' asset goroutine.
	printMu      sync.Mutex
	printDir     string
	printVersion int
)

// PrintSupported reports whether the print view can run here. False on other
// platforms, on a WebView2 too old for the calls, or if Wails has moved the
// fields the bridge reads -- and File > Print then opens the standard dialog.
func (a *App) PrintSupported() bool {
	if err := printProbe(a); err != nil {
		log.Printf("hashpad: print view unavailable, using the standard dialog: %v", err)
		return false
	}
	return true
}

// MakePrintPdf has the engine print the page as it stands to the kind's file
// and returns the address to fetch it from. The page's CSS decides margins and
// header; paper and orientation come here because the engine ignores CSS page
// size.
func (a *App) MakePrintPdf(kind, paper, orientation string) (string, error) {
	if !printKinds[kind] {
		return "", fmt.Errorf("print: unknown kind %q", kind)
	}
	size, ok := paperInches[paper]
	if !ok {
		return "", fmt.Errorf("print: unknown paper %q", paper)
	}
	w, h := size[0], size[1]
	switch orientation {
	case "portrait":
	case "landscape":
		w, h = h, w
	default:
		return "", fmt.Errorf("print: unknown orientation %q", orientation)
	}

	printJobs.Lock()
	defer printJobs.Unlock()
	dir, err := ensurePrintDir()
	if err != nil {
		return "", err
	}
	if err := printToPdf(a, filepath.Join(dir, kind+".pdf"), w, h); err != nil {
		return "", fmt.Errorf("print: %w", err)
	}

	printMu.Lock()
	printVersion++
	v := printVersion
	printMu.Unlock()
	return fmt.Sprintf("%s%s.pdf?v=%d", printRoute, kind, v), nil
}

// SavePrintPdf copies the final PDF to path, which the user chose in
// ShowExportDialog. As atomic as a save.
func (a *App) SavePrintPdf(path string) error {
	printMu.Lock()
	dir := printDir
	printMu.Unlock()
	if dir == "" {
		return errors.New("save pdf: no PDF has been made")
	}
	data, err := os.ReadFile(filepath.Join(dir, "final.pdf"))
	if err != nil {
		return fmt.Errorf("save pdf: %w", err)
	}
	return a.writeAtomic(path, data)
}

// ShowPrintDialog opens Windows' print dialog over the page as it stands.
func (a *App) ShowPrintDialog() error {
	printJobs.Lock()
	defer printJobs.Unlock()
	return showPrintUI(a)
}

// ClosePrint deletes the session's PDFs when the view closes.
func (a *App) ClosePrint() {
	removePrintDir()
}

func ensurePrintDir() (string, error) {
	printMu.Lock()
	defer printMu.Unlock()
	if printDir == "" {
		dir, err := os.MkdirTemp("", printTempPattern)
		if err != nil {
			return "", fmt.Errorf("print: %w", err)
		}
		printDir = dir
	}
	return printDir, nil
}

func removePrintDir() {
	printMu.Lock()
	defer printMu.Unlock()
	if printDir != "" {
		os.RemoveAll(printDir)
		printDir = ""
	}
}

// sweepPrintTemp removes what a crashed session left behind. Startup runs
// only in the instance that stays -- Wails exits a second one before
// OnStartup -- so nothing here can belong to a live session.
func sweepPrintTemp(tempDir string) {
	matches, _ := filepath.Glob(filepath.Join(tempDir, printTempPattern))
	for _, m := range matches {
		os.RemoveAll(m)
	}
}

// servePrint answers printRoute: exactly preview.pdf and final.pdf from this
// session's folder, nothing else.
func servePrint(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, printRoute)
	kind, isPdf := strings.CutSuffix(name, ".pdf")
	if !isPdf || !printKinds[kind] {
		http.NotFound(w, r)
		return
	}
	printMu.Lock()
	dir := printDir
	printMu.Unlock()
	if dir == "" {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	// The same address holds a new PDF after every change.
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}
