package app

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeEngine stands in for WebView2: it writes a recognisable "PDF" naming
// the page size it was asked for, and records every call.
func fakeEngine(t *testing.T) *[]string {
	t.Helper()
	var calls []string
	oldPrint, oldShow, oldProbe := printToPdf, showPrintUI, printProbe
	printToPdf = func(_ *App, path string, w, h float64) error {
		call := fmt.Sprintf("%s %.2fx%.2f", filepath.Base(path), w, h)
		calls = append(calls, call)
		return os.WriteFile(path, []byte("%PDF "+call), 0o644)
	}
	showPrintUI = func(*App) error {
		calls = append(calls, "dialog")
		return nil
	}
	printProbe = func(*App) error { return nil }
	t.Cleanup(func() {
		printToPdf, showPrintUI, printProbe = oldPrint, oldShow, oldProbe
		removePrintDir()
	})
	return &calls
}

func get(t *testing.T, url string) (int, string, http.Header) {
	t.Helper()
	rec := httptest.NewRecorder()
	AssetHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	body, _ := io.ReadAll(rec.Result().Body)
	return rec.Code, string(body), rec.Result().Header
}

func TestMakePrintPdfServesWhatTheEngineWrote(t *testing.T) {
	fakeEngine(t)

	url, err := New().MakePrintPdf("preview", "a4", "portrait")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "/__hashpad/print/preview.pdf?v=") {
		t.Fatalf("url = %q", url)
	}
	code, body, header := get(t, url)
	if code != http.StatusOK || body != "%PDF preview.pdf 8.27x11.69" {
		t.Fatalf("GET %s = %d %q", url, code, body)
	}
	if header.Get("Content-Type") != "application/pdf" || header.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers = %v", header)
	}
}

// The same address holds a new PDF after every change, so each one gets a new
// query string as well as no-store.
func TestEachPdfGetsItsOwnAddress(t *testing.T) {
	fakeEngine(t)
	a := New()

	first, err := a.MakePrintPdf("preview", "a4", "portrait")
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.MakePrintPdf("preview", "a4", "portrait")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("both PDFs at %q", first)
	}
}

func TestMakePrintPdfTurnsLandscapePaperSideways(t *testing.T) {
	calls := fakeEngine(t)

	if _, err := New().MakePrintPdf("final", "letter", "landscape"); err != nil {
		t.Fatal(err)
	}
	if got := (*calls)[0]; got != "final.pdf 11.00x8.50" {
		t.Fatalf("engine asked for %q", got)
	}
}

func TestMakePrintPdfRefusesWhatItDoesNotKnow(t *testing.T) {
	calls := fakeEngine(t)
	a := New()
	for _, args := range [][3]string{
		{"../x", "a4", "portrait"},
		{"preview", "a3", "portrait"},
		{"preview", "a4", "sideways"},
	} {
		if _, err := a.MakePrintPdf(args[0], args[1], args[2]); err == nil {
			t.Errorf("MakePrintPdf%v succeeded", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("engine called for bad arguments: %v", *calls)
	}
}

func TestMakePrintPdfReportsTheEnginesFailure(t *testing.T) {
	fakeEngine(t)
	printToPdf = func(*App, string, float64, float64) error { return errors.New("engine broke") }

	if _, err := New().MakePrintPdf("preview", "a4", "portrait"); err == nil || !strings.Contains(err.Error(), "engine broke") {
		t.Fatalf("err = %v", err)
	}
}

func TestPrintRouteServesOnlyTheTwoPdfs(t *testing.T) {
	fakeEngine(t)
	if _, err := New().MakePrintPdf("preview", "a4", "portrait"); err != nil {
		t.Fatal(err)
	}
	// A real file beside the two, so only the name check can keep it out.
	if err := os.WriteFile(filepath.Join(printDir, "other.pdf"), []byte("%PDF other"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{
		"/__hashpad/print/final.pdf", // not made yet
		"/__hashpad/print/other.pdf",
		"/__hashpad/print/preview",
		"/__hashpad/print/../print/preview.pdf",
		"/__hashpad/print/",
	} {
		if code, _, _ := get(t, url); code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", url, code)
		}
	}
}

func TestPrintRouteServesNothingBeforeTheFirstPdf(t *testing.T) {
	fakeEngine(t)
	if code, _, _ := get(t, "/__hashpad/print/preview.pdf"); code != http.StatusNotFound {
		t.Fatalf("GET = %d, want 404", code)
	}
}

func TestClosePrintDeletesTheFolder(t *testing.T) {
	fakeEngine(t)
	a := New()
	url, err := a.MakePrintPdf("preview", "a4", "portrait")
	if err != nil {
		t.Fatal(err)
	}
	dir := printDir

	a.ClosePrint()

	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("print folder still there: %v", err)
	}
	if code, _, _ := get(t, url); code != http.StatusNotFound {
		t.Fatalf("GET after close = %d", code)
	}
}

func TestShutdownDeletesThePrintFolder(t *testing.T) {
	fakeEngine(t)
	a := New()
	if _, err := a.MakePrintPdf("preview", "a4", "portrait"); err != nil {
		t.Fatal(err)
	}
	dir := printDir

	a.Shutdown(nil)

	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("print folder survived shutdown: %v", err)
	}
}

func TestSavePrintPdfCopiesTheFinalPdf(t *testing.T) {
	fakeEngine(t)
	a := New()
	if err := a.SavePrintPdf(filepath.Join(t.TempDir(), "x.pdf")); err == nil {
		t.Fatal("saved with no PDF made")
	}
	if _, err := a.MakePrintPdf("final", "a4", "portrait"); err != nil {
		t.Fatal(err)
	}
	to := filepath.Join(t.TempDir(), "notes.pdf")

	if err := a.SavePrintPdf(to); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(to); string(got) != "%PDF final.pdf 8.27x11.69" {
		t.Fatalf("saved %q", got)
	}
}

func TestShowPrintDialogCallsTheEngine(t *testing.T) {
	calls := fakeEngine(t)
	if err := New().ShowPrintDialog(); err != nil || len(*calls) != 1 || (*calls)[0] != "dialog" {
		t.Fatalf("err %v, calls %v", err, *calls)
	}
}

func TestPrintSupportedFollowsTheProbe(t *testing.T) {
	fakeEngine(t)
	if !New().PrintSupported() {
		t.Fatal("unsupported with a working engine")
	}
	printProbe = func(*App) error { return errors.New("no webview") }
	if New().PrintSupported() {
		t.Fatal("supported with a failing probe")
	}
}

func TestSweepRemovesOnlyHashpadPrintLeftovers(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"hashpad-print-123", "hashpad-print-9.html", "keep.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, "hashpad-print-folder", "inside"), 0o755); err != nil {
		t.Fatal(err)
	}

	sweepPrintTemp(dir)

	left, _ := os.ReadDir(dir)
	if len(left) != 1 || left[0].Name() != "keep.txt" {
		t.Fatalf("left %v", left)
	}
}
