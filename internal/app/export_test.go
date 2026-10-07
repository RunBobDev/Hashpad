package app

import "testing"

// An unknown kind is refused before any dialog opens, so this needs no
// Wails context.
func TestShowExportDialogRejectsAnUnknownKind(t *testing.T) {
	if _, err := New().ShowExportDialog("a.pdf", "pdf"); err == nil {
		t.Fatal("want an error for an unknown kind")
	}
}

// The extension added when Windows' dialog leaves it off, which it does
// whenever "All files" is the chosen filter.
func TestExportKindsAddTheirExtension(t *testing.T) {
	for kind, want := range map[string]string{"html": ".html", "text": ".txt"} {
		k, ok := exportKinds[kind]
		if !ok {
			t.Fatalf("no export kind %q", kind)
		}
		if k.ext != want {
			t.Errorf("%s: ext %q, want %q", kind, k.ext, want)
		}
	}
}
