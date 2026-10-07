package app

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type emitted struct {
	event string
	data  any
}

// startWatcher returns a running watcher whose events land on the channel.
func startWatcher(t *testing.T) (*watcher, <-chan emitted) {
	t.Helper()
	events := make(chan emitted, 32)
	w, err := newWatcher(func(event string, data any) { events <- emitted{event, data} })
	if err != nil {
		t.Fatalf("newWatcher() error = %v", err)
	}
	t.Cleanup(w.close)
	return w, events
}

// watched writes content to a fresh file and starts watching it. Files are
// written with settings_test.go's `write`.
func watched(t *testing.T, content string) (*watcher, <-chan emitted, string) {
	t.Helper()
	w, events := startWatcher(t)
	path := filepath.Join(t.TempDir(), "note.md")
	write(t, path, content)
	w.set([]string{path})
	return w, events, path
}

// next waits for the watcher's next event. A channel with a timeout, never a
// bare sleep: how long a real filesystem takes to report is not ours to guess.
func next(t *testing.T, events <-chan emitted) emitted {
	t.Helper()
	select {
	case e := <-events:
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no event within 5s")
		return emitted{}
	}
}

// quiet asserts nothing arrives for ten settle periods. On its own that proves
// nothing -- a dead watcher is quiet too -- so every caller follows it with a
// change that must arrive.
func quiet(t *testing.T, events <-chan emitted) {
	t.Helper()
	select {
	case e := <-events:
		t.Fatalf("unexpected %s: %+v", e.event, e.data)
	case <-time.After(10 * watchSettle):
	}
}

func changedTo(t *testing.T, e emitted, path, content string) {
	t.Helper()
	if e.event != fileChangedEvent {
		t.Fatalf("event = %q (%+v), want %q", e.event, e.data, fileChangedEvent)
	}
	got, ok := e.data.(FileContents)
	if !ok {
		t.Fatalf("payload is %T, want FileContents", e.data)
	}
	if got.Path != path || got.Content != content {
		t.Fatalf("got %q at %q, want %q at %q", got.Content, got.Path, content, path)
	}
}

func TestWatcherReportsAnExternalWriteOnce(t *testing.T) {
	t.Parallel()
	_, events, path := watched(t, "before")

	write(t, path, "after")
	changedTo(t, next(t, events), path, "after")
	// One write is several events. They settle into one report.
	quiet(t, events)

	write(t, path, "again")
	changedTo(t, next(t, events), path, "again")
}

func TestWatcherCoalescesABurst(t *testing.T) {
	t.Parallel()
	_, events, path := watched(t, "0")

	for i := 1; i <= 10; i++ {
		write(t, path, strings.Repeat("x", i))
	}
	changedTo(t, next(t, events), path, strings.Repeat("x", 10))
	quiet(t, events)
}

// The rename WriteFile saves with fires events for the target. Content, not
// timing, is what keeps them from reporting our own save back to us.
func TestWatcherIgnoresItsOwnWrites(t *testing.T) {
	t.Parallel()
	w, events, path := watched(t, "before")
	a := &App{watch: w}

	if err := a.WriteFile(path, "mine", EncodingUTF8, LineEndingLF); err != nil {
		t.Fatal(err)
	}
	quiet(t, events)

	write(t, path, "theirs")
	changedTo(t, next(t, events), path, "theirs")
}

func TestWatcherIgnoresATouchThatChangesNothing(t *testing.T) {
	t.Parallel()
	_, events, path := watched(t, "before")
	write(t, path, "after")
	changedTo(t, next(t, events), path, "after")

	write(t, path, "after")
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	quiet(t, events)

	write(t, path, "later")
	changedTo(t, next(t, events), path, "later")
}

// The reason the watcher watches directories: a watch on the file itself is
// lost the first time something replaces it by rename.
func TestWatcherSurvivesReplaceByRename(t *testing.T) {
	t.Parallel()
	_, events, path := watched(t, "before")

	for _, content := range []string{"first", "second"} {
		tmp := path + ".tmp"
		write(t, tmp, content)
		if err := os.Rename(tmp, path); err != nil {
			t.Fatal(err)
		}
		changedTo(t, next(t, events), path, content)
	}
}

func TestWatcherReportsADeletionOnce(t *testing.T) {
	t.Parallel()
	_, events, path := watched(t, "before")

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if e := next(t, events); e.event != fileDeletedEvent || e.data != path {
		t.Fatalf("got %s %v, want %s %s", e.event, e.data, fileDeletedEvent, path)
	}

	// Created and removed again inside one settle period: still missing, so
	// nothing new to say.
	write(t, path, "blink")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	quiet(t, events)

	write(t, path, "restored")
	changedTo(t, next(t, events), path, "restored")
}

func TestWatcherIgnoresNeighbours(t *testing.T) {
	t.Parallel()
	_, events, path := watched(t, "before")

	write(t, filepath.Join(filepath.Dir(path), "other.md"), "noise")
	quiet(t, events)

	write(t, path, "after")
	changedTo(t, next(t, events), path, "after")
}

func TestWatcherForgetsPathsNoLongerOpen(t *testing.T) {
	t.Parallel()
	w, events, path := watched(t, "before")

	w.set(nil)
	write(t, path, "unwatched")
	quiet(t, events)

	w.set([]string{path})
	write(t, path, "watched")
	changedTo(t, next(t, events), path, "watched")
}

// A file opened from the command line keeps the case it was typed in; the
// watcher reports the case on disk.
func TestWatcherMatchesPathsRegardlessOfCase(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("case-insensitive paths are a Windows property")
	}
	t.Parallel()
	w, events := startWatcher(t)
	dir := t.TempDir()
	write(t, filepath.Join(dir, "Note.md"), "before")
	typed := filepath.Join(dir, "note.md")
	w.set([]string{typed})

	write(t, typed, "after")
	changedTo(t, next(t, events), typed, "after")
}
