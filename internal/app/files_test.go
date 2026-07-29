package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWriteFileReadFileRoundTrip guards the basic contract WriteFile and
// ReadFile must uphold together: whatever content, encoding, and line ending
// go in via WriteFile must come back unchanged via ReadFile.
func TestWriteFileReadFileRoundTrip(t *testing.T) {
	tests := []struct {
		name    string
		content string
		enc     Encoding
		ending  LineEnding
	}{
		{name: "utf-8 with lf", content: "first\nsecond\n", enc: EncodingUTF8, ending: LineEndingLF},
		{name: "utf-8 with crlf", content: "first\nsecond\n", enc: EncodingUTF8, ending: LineEndingCRLF},
		{name: "utf-8 bom with lf", content: "hello\nworld\n", enc: EncodingUTF8BOM, ending: LineEndingLF},
		{name: "utf-16le with crlf", content: "hi\nthere\n", enc: EncodingUTF16LE, ending: LineEndingCRLF},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := &App{}
			dir := t.TempDir()
			path := filepath.Join(dir, "note.md")

			if err := a.WriteFile(path, tt.content, tt.enc, tt.ending); err != nil {
				t.Fatalf("WriteFile() error = %v", err)
			}

			got, err := a.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile() error = %v", err)
			}
			if got.Content != tt.content {
				t.Errorf("Content = %q, want %q", got.Content, tt.content)
			}
			if got.Encoding != tt.enc {
				t.Errorf("Encoding = %q, want %q", got.Encoding, tt.enc)
			}
			if got.LineEnding != tt.ending {
				t.Errorf("LineEnding = %q, want %q", got.LineEnding, tt.ending)
			}
		})
	}
}

// TestWriteFileReplacesExistingContent guards against the replace becoming an
// append: writing shorter content over a longer existing file must leave only
// the shorter content behind, not the old bytes trailing after it.
func TestWriteFileReplacesExistingContent(t *testing.T) {
	a := &App{}
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")

	longContent := "this is the original, much longer file content\nwith a second line\n"
	if err := a.WriteFile(path, longContent, EncodingUTF8, LineEndingLF); err != nil {
		t.Fatalf("initial WriteFile() error = %v", err)
	}

	shortContent := "short\n"
	if err := a.WriteFile(path, shortContent, EncodingUTF8, LineEndingLF); err != nil {
		t.Fatalf("replacing WriteFile() error = %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("os.ReadFile() error = %v", err)
	}
	if string(raw) != shortContent {
		t.Errorf("file contents = %q, want %q (old content must not remain)", string(raw), shortContent)
	}
}

// TestWriteFileLeavesNoLeftoverTempFiles is the regression guard for the
// crash-safe write path: WriteFile writes to a temp file and renames it over
// the target, and that temp file must never survive a successful call.
func TestWriteFileLeavesNoLeftoverTempFiles(t *testing.T) {
	a := &App{}
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")

	if err := a.WriteFile(path, "hello\n", EncodingUTF8, LineEndingLF); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("os.ReadDir() error = %v", err)
	}
	if len(entries) != 1 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Fatalf("directory has %d entries, want 1 (target only); got %v", len(entries), names)
	}
	if entries[0].Name() != "note.md" {
		t.Errorf("directory entry = %q, want %q", entries[0].Name(), "note.md")
	}
}

// TestReadFileMissingPathIncludesPathInError ensures a failed read tells the
// caller which path it tried, matching the wrapping convention used elsewhere
// in this file.
func TestReadFileMissingPathIncludesPathInError(t *testing.T) {
	a := &App{}
	path := filepath.Join(t.TempDir(), "does-not-exist.md")

	_, err := a.ReadFile(path)
	if err == nil {
		t.Fatal("ReadFile() error = nil, want an error for a missing file")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error = %q, want it to contain path %q", err.Error(), path)
	}
}

// TestReadFileDetectsCRLF confirms ReadFile surfaces CRLF detection through to
// the caller (delegating to Decode) and that the returned content is
// LF-normalised, not left with raw \r\n in it.
func TestReadFileDetectsCRLF(t *testing.T) {
	a := &App{}
	dir := t.TempDir()
	path := filepath.Join(dir, "crlf.md")

	raw := []byte("line one\r\nline two\r\n")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("test setup os.WriteFile() error = %v", err)
	}

	got, err := a.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if got.LineEnding != LineEndingCRLF {
		t.Errorf("LineEnding = %q, want %q", got.LineEnding, LineEndingCRLF)
	}
	want := "line one\nline two\n"
	if got.Content != want {
		t.Errorf("Content = %q, want %q (LF-normalised)", got.Content, want)
	}
}
