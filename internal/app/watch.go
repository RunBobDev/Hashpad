package app

import (
	"crypto/sha256"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// SPEC §7.4: open files are watched, and a change on disk is pushed to the
// frontend, which decides what it means for the document (files/diskwatch.ts).
const (
	fileChangedEvent = "file:changed"
	fileDeletedEvent = "file:deleted"

	// watchSettle is how long a path must be quiet before it is read. One save
	// is several events -- a truncate and a write, or a temp file renamed over
	// the target -- and reading between them would report a half-written file.
	watchSettle = 100 * time.Millisecond

	// watchRetries bounds how often an unreadable file is looked at again. On
	// Windows the usual cause is another program still holding it open for
	// writing, which clears in milliseconds.
	watchRetries = 5
)

// digest is what Go last knew a watched path to hold: the hash of its bytes,
// or that it was missing. The zero value means nothing is known yet, so the
// first change seen is always reported. Over-reporting is harmless -- the
// frontend compares against what *it* believes is on disk -- and that is why
// ReadFile does not record one: a re-open landing between an external write
// and its check would mark the write as seen while the tab still held the old
// text.
type digest struct {
	known   bool
	missing bool
	sum     [sha256.Size]byte
}

type watchedFile struct {
	path  string // as the frontend spelled it, which is how it is reported back
	last  digest
	timer *time.Timer
	tries int
}

// watcher watches the *directories* holding open files, not the files.
//
// A watch on a file is lost when the file is replaced by a rename, and that is
// how WriteFile saves -- and how git and many editors write too. A directory
// watch survives all of them, at the cost of filtering neighbours out by name.
type watcher struct {
	notify *fsnotify.Watcher
	emit   func(event string, data any)

	// mu guards everything below and is held across each check's read and
	// emit, so two checks of one path cannot report an older read after a
	// newer one.
	mu    sync.Mutex
	files map[string]*watchedFile // by pathKey
	dirs  map[string]string       // pathKey -> the directory as added
}

func newWatcher(emit func(event string, data any)) (*watcher, error) {
	notify, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &watcher{
		notify: notify,
		emit:   emit,
		files:  map[string]*watchedFile{},
		dirs:   map[string]string{},
	}
	go w.loop()
	return w, nil
}

// SetWatchedFiles makes paths the complete set of files watched for changes on
// disk. The frontend sends every open file's path whenever that list changes
// (files/diskwatch.ts), so it never has to remember what it said last time.
func (a *App) SetWatchedFiles(paths []string) {
	a.watch.set(paths)
}

// set is SetWatchedFiles. A nil watcher -- fsnotify failed to start -- is a
// no-op, so the app loses change detection and nothing else.
func (w *watcher) set(paths []string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()

	want := make(map[string]string, len(paths))
	for _, p := range paths {
		want[pathKey(p)] = p
	}

	for k, f := range w.files {
		if _, ok := want[k]; !ok {
			if f.timer != nil {
				f.timer.Stop()
			}
			delete(w.files, k)
		}
	}
	for k, p := range want {
		if f, ok := w.files[k]; ok {
			f.path = p
		} else {
			w.files[k] = &watchedFile{path: p}
		}
	}

	needed := make(map[string]string, len(w.files))
	for _, f := range w.files {
		dir := filepath.Dir(f.path)
		needed[pathKey(dir)] = dir
	}
	for k, dir := range w.dirs {
		if _, ok := needed[k]; !ok {
			// Fails only if the directory is already gone, which ended the
			// watch anyway.
			_ = w.notify.Remove(dir)
			delete(w.dirs, k)
		}
	}
	for k, dir := range needed {
		if _, ok := w.dirs[k]; ok {
			continue
		}
		// A directory that cannot be watched -- a network share without
		// change notification, say -- costs its files their change detection
		// and nothing more. Not recorded, so the next call tries again.
		if err := w.notify.Add(dir); err != nil {
			log.Printf("hashpad: cannot watch %s: %v", dir, err)
			continue
		}
		w.dirs[k] = dir
	}
}

// wrote records the bytes WriteFile is about to rename into place, so the
// events that rename causes find nothing new. Called before the rename, so
// there is no moment at which those bytes are on disk and unaccounted for.
func (w *watcher) wrote(path string, data []byte) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if f := w.files[pathKey(path)]; f != nil {
		f.last = digest{known: true, sum: sha256.Sum256(data)}
	}
}

// close stops the watcher. Only tests call it: the app's watcher lives as long
// as the process does.
func (w *watcher) close() {
	w.mu.Lock()
	for _, f := range w.files {
		if f.timer != nil {
			f.timer.Stop()
		}
	}
	w.files = map[string]*watchedFile{}
	w.mu.Unlock()
	_ = w.notify.Close()
}

func (w *watcher) loop() {
	for {
		select {
		case event, ok := <-w.notify.Events:
			if !ok {
				return
			}
			w.touched(event.Name)
		case err, ok := <-w.notify.Errors:
			if !ok {
				return
			}
			// Usually an overflow: more changes at once than the buffer holds,
			// some of them lost. Checking every file costs a read each and
			// reports only what actually changed.
			log.Printf("hashpad: file watcher: %v", err)
			w.recheckAll()
		}
	}
}

// touched restarts a watched file's settle timer. Every kind of event counts --
// a write, a create, a rename over it, a removal, an attribute change --
// because the check that follows compares contents, and that is the filter.
func (w *watcher) touched(name string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if f := w.files[pathKey(name)]; f != nil {
		w.schedule(f)
	}
}

func (w *watcher) recheckAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, f := range w.files {
		w.schedule(f)
	}
}

// schedule (re)arms f's check. Callers hold mu.
func (w *watcher) schedule(f *watchedFile) {
	if f.timer == nil {
		f.timer = time.AfterFunc(watchSettle, func() { w.check(f) })
		return
	}
	f.timer.Reset(watchSettle)
}

// check reads f and reports it if it no longer holds what was last known.
func (w *watcher) check(f *watchedFile) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Dropped by set, or by close, while the timer was running.
	if w.files[pathKey(f.path)] != f {
		return
	}

	raw, err := os.ReadFile(f.path)
	var now digest
	switch {
	case err == nil:
		now = digest{known: true, sum: sha256.Sum256(raw)}
	case errors.Is(err, fs.ErrNotExist):
		now = digest{known: true, missing: true}
	default:
		if f.tries < watchRetries {
			f.tries++
			w.schedule(f)
			return
		}
		log.Printf("hashpad: cannot read %s to check it: %v", f.path, err)
		f.tries = 0
		return
	}
	f.tries = 0

	if now == f.last {
		return
	}
	f.last = now

	if now.missing {
		w.emit(fileDeletedEvent, f.path)
		return
	}
	content, enc, ending, mixed := Decode(raw)
	w.emit(fileChangedEvent, FileContents{
		Path:       f.path,
		Content:    content,
		Encoding:   enc,
		LineEnding: ending,
		Mixed:      mixed,
	})
}

// pathKey is how paths are compared. Windows filenames are case-insensitive,
// and the two sides spell them independently: a file opened from the command
// line keeps the case it was typed in, while the watcher reports the case on
// disk.
//
// A known ceiling: ToLower is close to NTFS's case folding, not identical. If a
// script ever mismatches, fall back to os.SameFile on a miss.
func pathKey(path string) string {
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}
