package app

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// An unknown kind is refused before any dialog opens, so this needs no
// Wails context.
func TestShowExportDialogRejectsAnUnknownKind(t *testing.T) {
	if _, err := New().ShowExportDialog("a.docx", "docx"); err == nil {
		t.Fatal("want an error for an unknown kind")
	}
}

// The extension added when Windows' dialog leaves it off, which it does
// whenever "All files" is the chosen filter.
func TestExportKindsAddTheirExtension(t *testing.T) {
	for kind, want := range map[string]string{"html": ".html", "text": ".txt", "pdf": ".pdf"} {
		k, ok := exportKinds[kind]
		if !ok {
			t.Fatalf("no export kind %q", kind)
		}
		if k.ext != want {
			t.Errorf("%s: ext %q, want %q", kind, k.ext, want)
		}
	}
}

// stubOpen records what would have been handed to the shell, so no test ever
// starts a browser.
func stubOpen(t *testing.T) *[]string {
	t.Helper()
	var opened []string
	saved := openExternal
	openExternal = func(target string) error {
		opened = append(opened, target)
		return nil
	}
	t.Cleanup(func() { openExternal = saved })
	return &opened
}

// The bound method is the trust boundary: whatever the preview checked, a
// document's link reaches the shell only if it is a web or mail address.
// rundll32's FileProtocolHandler would happily run a local program.
func TestOpenURLOpensOnlyWebAndMail(t *testing.T) {
	opened := stubOpen(t)
	a := New()

	for _, ok := range []string{
		"https://example.com/a?b=c&d=e",
		"http://example.com",
		"mailto:someone@example.com",
		"HTTPS://example.com",
	} {
		if err := a.OpenURL(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"javascript:alert(1)",
		"file:///C:/Windows/notepad.exe",
		`C:\Windows\notepad.exe`,
		"",
		"ms-settings:",
		"//example.com",
	} {
		if err := a.OpenURL(bad); err == nil {
			t.Errorf("%q: want a refusal", bad)
		}
	}
	if len(*opened) != 4 {
		t.Fatalf("opened %q, want the four web and mail addresses", *opened)
	}
}

func TestOpenInBrowserWritesATempPageAndShutdownRemovesIt(t *testing.T) {
	opened := stubOpen(t)
	a := New()

	if err := a.OpenInBrowser("<p>hello</p>"); err != nil {
		t.Fatal(err)
	}
	if len(*opened) != 1 {
		t.Fatalf("opened %q, want one page", *opened)
	}
	u, err := url.Parse((*opened)[0])
	if err != nil || u.Scheme != "file" {
		t.Fatalf("opened %q, want a file URL", (*opened)[0])
	}
	path := u.Path
	if runtime.GOOS == "windows" {
		// file:///C:/Users/... -> C:\Users\...
		path = filepath.FromSlash(path[1:])
	}

	got, err := os.ReadFile(path)
	if err != nil || string(got) != "<p>hello</p>" {
		t.Fatalf("read %s: %q, %v", path, got, err)
	}

	a.Shutdown(context.Background())
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the temporary page survived shutdown: %v", err)
	}
}

// A shell refusal must not leave the page behind until shutdown with nobody
// looking at it -- and must reach the frontend as an error.
func TestOpenInBrowserReportsAShellFailure(t *testing.T) {
	var target string
	saved := openExternal
	openExternal = func(t string) error {
		target = t
		return errors.New("no handler")
	}
	t.Cleanup(func() { openExternal = saved })

	if err := New().OpenInBrowser("<p>x</p>"); err == nil {
		t.Fatal("want the shell's error")
	}
	u, err := url.Parse(target)
	if err != nil {
		t.Fatalf("opened %q", target)
	}
	path := u.Path
	if runtime.GOOS == "windows" {
		path = filepath.FromSlash(path[1:])
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the page nobody opened is still there: %v", err)
	}
}
