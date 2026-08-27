package app

import (
	"os"
	"path/filepath"
	"testing"
)

// fixture builds a directory holding one real file and one subdirectory, and
// returns the directory and the file's absolute path.
func fixture(t *testing.T) (dir string, file string) {
	t.Helper()

	dir = t.TempDir()
	file = filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("# notes\n"), 0o600); err != nil {
		t.Fatalf("write fixture file: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatalf("make fixture directory: %v", err)
	}

	return dir, file
}

func equalPaths(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// A command line is not a curated list. It carries flags, directories, paths to
// files that have been moved since the shortcut was made, and — from Wails'
// single-instance payload — the occasional empty string. Only regular files can
// be opened, so only regular files come through.
func TestResolveFileArgsKeepsOnlyRegularFiles(t *testing.T) {
	dir, file := fixture(t)

	got := resolveFileArgs([]string{
		file,
		filepath.Join(dir, "subdir"),
		filepath.Join(dir, "moved-away.md"),
		"--version",
		"",
	}, dir)

	if !equalPaths(got, []string{file}) {
		t.Errorf("resolveFileArgs = %q, want %q", got, []string{file})
	}
}

// Explorer and a shell both hand over paths relative to where they were
// invoked, and for a second instance that directory is the *other* process's,
// which is why it travels as an argument rather than being read here.
func TestResolveFileArgsResolvesRelativeAgainstCwd(t *testing.T) {
	dir, file := fixture(t)

	got := resolveFileArgs([]string{"notes.md"}, dir)

	if !equalPaths(got, []string{file}) {
		t.Errorf("resolveFileArgs = %q, want %q", got, []string{file})
	}
}

// The path that comes back must be usable as-is: `openPaths` hands it straight
// to ReadFile, and the frontend then compares it against the paths of open tabs
// to decide whether a file is already open (H.10). A parent segment left in
// would read the right file under a spelling that matches no tab.
func TestResolveFileArgsResolvesParentSegments(t *testing.T) {
	dir, file := fixture(t)

	got := resolveFileArgs([]string{filepath.Join("..", "notes.md")}, filepath.Join(dir, "subdir"))

	if !equalPaths(got, []string{file}) {
		t.Errorf("resolveFileArgs = %q, want %q", got, []string{file})
	}
}

// Order is the order they were named. Opening three files from one command line
// should give three tabs in the order asked for, the same as a multi-file drop.
func TestResolveFileArgsPreservesOrder(t *testing.T) {
	dir := t.TempDir()
	var files []string
	for _, name := range []string{"c.md", "a.md", "b.md"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		files = append(files, path)
	}

	got := resolveFileArgs(files, dir)

	if !equalPaths(got, files) {
		t.Errorf("resolveFileArgs = %q, want %q", got, files)
	}
}

// The case that makes this file exist: a launch before there is a window has
// nowhere to send an event, so the paths wait for the frontend to ask.
func TestOpenFromCommandLineQueuesBeforeStartup(t *testing.T) {
	dir, file := fixture(t)
	a := New()

	a.OpenFromCommandLine([]string{file}, dir)

	if got := a.PendingFiles(); !equalPaths(got, []string{file}) {
		t.Errorf("PendingFiles = %q, want %q", got, []string{file})
	}
}

// A second Hashpad started while the first is still initialising lands in the
// same queue rather than replacing what is already there — Wails creates the
// window that receives its message long before it dispatches OnStartup, so both
// sets of files can be waiting at once.
func TestOpenFromCommandLineAccumulatesLaunches(t *testing.T) {
	dir, first := fixture(t)
	second := filepath.Join(dir, "other.md")
	if err := os.WriteFile(second, nil, 0o600); err != nil {
		t.Fatalf("write second file: %v", err)
	}
	a := New()

	a.OpenFromCommandLine([]string{first}, dir)
	a.OpenFromCommandLine([]string{second}, dir)

	if got := a.PendingFiles(); !equalPaths(got, []string{first, second}) {
		t.Errorf("PendingFiles = %q, want %q", got, []string{first, second})
	}
}

// Draining is the point: once the frontend is listening, later launches arrive
// as events instead, and a queue that still held the startup files would open
// them a second time.
func TestPendingFilesDrains(t *testing.T) {
	dir, file := fixture(t)
	a := New()
	a.OpenFromCommandLine([]string{file}, dir)

	if got := a.PendingFiles(); len(got) != 1 {
		t.Fatalf("first PendingFiles = %q, want one path", got)
	}

	if got := a.PendingFiles(); len(got) != 0 {
		t.Errorf("second PendingFiles = %q, want nothing left", got)
	}
}

// A nil slice marshals to JSON `null`, and this crosses the IPC boundary to
// TypeScript that filters it by extension. `null` there is a TypeError during
// startup, inside the same bootstrap whose failure leaves the window hidden.
func TestPendingFilesIsNeverNil(t *testing.T) {
	if got := New().PendingFiles(); got == nil {
		t.Error("PendingFiles on a fresh app returned nil, want an empty slice")
	}
}
