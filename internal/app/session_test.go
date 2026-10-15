package app

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// sessionSettings points SettingsPath at a fresh directory and returns the
// file it will use, the way the reset tests do.
func sessionSettings(t *testing.T) string {
	t.Helper()
	t.Setenv("APPDATA", t.TempDir())
	path, err := SettingsPath()
	if err != nil {
		t.Fatalf("settings path: %v", err)
	}
	return path
}

func TestOlderSettingsGetTheSessionDefaults(t *testing.T) {
	path := sessionSettings(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version": 3, "files": {"autosave": true}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	s, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Files.ReopenTabs {
		t.Error("reopenTabs = false, want the default true for a file without the key")
	}
	if !s.Files.Autosave {
		t.Error("autosave lost: the file's own values must survive")
	}
	want := SessionState{RecentFiles: []string{}, OpenTabs: []string{}, ActiveTab: -1}
	if !reflect.DeepEqual(s.Session, want) {
		t.Errorf("session = %+v, want %+v", s.Session, want)
	}
}

func TestRecentFilesAreNewestFirstOnceAndAtMostTen(t *testing.T) {
	sessionSettings(t)
	app := &App{}
	for i := 0; i < 12; i++ {
		if _, err := app.RememberOpened(fmt.Sprintf(`C:\docs\%d.md`, i)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := app.RememberOpened(`C:\docs\5.md`)
	if err != nil {
		t.Fatal(err)
	}

	want := []string{`C:\docs\5.md`, `C:\docs\11.md`, `C:\docs\10.md`, `C:\docs\9.md`, `C:\docs\8.md`,
		`C:\docs\7.md`, `C:\docs\6.md`, `C:\docs\4.md`, `C:\docs\3.md`, `C:\docs\2.md`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("recent = %v\nwant     %v", got, want)
	}
}

func TestForgetAndClearRecent(t *testing.T) {
	sessionSettings(t)
	app := &App{}
	app.RememberOpened(`C:\a.md`)
	app.RememberOpened(`C:\b.md`)

	got, err := app.ForgetRecent(`C:\a.md`)
	if err != nil || !reflect.DeepEqual(got, []string{`C:\b.md`}) {
		t.Fatalf("after forget: %v, %v", got, err)
	}
	got, err = app.ClearRecent()
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("after clear: %#v, %v (want an empty, non-nil list)", got, err)
	}
}

func TestRememberTabsStoresPathsAndTheActiveOne(t *testing.T) {
	path := sessionSettings(t)
	app := &App{}
	if err := app.RememberTabs([]string{`C:\a.md`, `C:\b.md`}, 1); err != nil {
		t.Fatal(err)
	}
	s, _ := LoadSettingsFrom(path)
	if !reflect.DeepEqual(s.Session.OpenTabs, []string{`C:\a.md`, `C:\b.md`}) || s.Session.ActiveTab != 1 {
		t.Errorf("session = %+v", s.Session)
	}

	// An index that names no tab is stored as "an unsaved document was active".
	if err := app.RememberTabs([]string{`C:\a.md`}, 5); err != nil {
		t.Fatal(err)
	}
	s, _ = LoadSettingsFrom(path)
	if s.Session.ActiveTab != -1 {
		t.Errorf("activeTab = %d, want -1", s.Session.ActiveTab)
	}
}

// The owner's "gitignore for settings": a settings change never writes the
// session section, so it cannot put back an older recent list.
func TestSaveSettingsKeepsTheSessionOnDisk(t *testing.T) {
	path := sessionSettings(t)
	app := &App{}
	app.RememberOpened(`C:\kept.md`)

	changed := DefaultSettings()
	changed.Appearance.Theme = "dark"
	changed.Session.RecentFiles = []string{`C:\stale.md`}
	if err := app.SaveSettings(changed); err != nil {
		t.Fatal(err)
	}

	s, _ := LoadSettingsFrom(path)
	if s.Appearance.Theme != "dark" {
		t.Errorf("theme = %q, want the saved change", s.Appearance.Theme)
	}
	if !reflect.DeepEqual(s.Session.RecentFiles, []string{`C:\kept.md`}) {
		t.Errorf("recent = %v, want the list on disk, not the frontend's copy", s.Session.RecentFiles)
	}
}

func TestResetSettingsKeepsTheSession(t *testing.T) {
	path := sessionSettings(t)
	app := &App{}
	app.RememberOpened(`C:\kept.md`)
	app.RememberTabs([]string{`C:\kept.md`}, 0)

	got, err := app.ResetSettings()
	if err != nil {
		t.Fatal(err)
	}
	s, _ := LoadSettingsFrom(path)
	for _, session := range []SessionState{got.Session, s.Session} {
		if !reflect.DeepEqual(session.RecentFiles, []string{`C:\kept.md`}) || session.ActiveTab != 0 {
			t.Errorf("session after reset = %+v", session)
		}
	}
}

func TestTheSessionIsTheLastSection(t *testing.T) {
	path := sessionSettings(t)
	if err := SaveSettingsTo(path, DefaultSettings()); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	text := string(data)
	if !(strings.Index(text, `"session"`) > strings.Index(text, `"print"`)) {
		t.Errorf("session is not after print:\n%s", text)
	}
}

// Without settingsMu, read-modify-write from two goroutines loses updates and
// collides in the rename. With it, every remembered file survives (the last
// ten) and the settings change is kept.
func TestSettingsAndSessionWritersDoNotLoseEachOther(t *testing.T) {
	path := sessionSettings(t)
	app := &App{}
	dark := DefaultSettings()
	dark.Appearance.Theme = "dark"

	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_, err := app.RememberOpened(fmt.Sprintf(`C:\docs\%d.md`, i))
			errs <- err
		}(i)
		go func() {
			defer wg.Done()
			errs <- app.SaveSettings(dark)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a writer failed: %v", err)
		}
	}

	s, _ := LoadSettingsFrom(path)
	if len(s.Session.RecentFiles) != 10 {
		t.Errorf("recent has %d entries, want 10: updates were lost", len(s.Session.RecentFiles))
	}
	if s.Appearance.Theme != "dark" {
		t.Errorf("theme = %q, want dark", s.Appearance.Theme)
	}
}

// The atomic write leaves nothing behind beside the file.
func TestSaveSettingsToLeavesNoTempFile(t *testing.T) {
	path := sessionSettings(t)
	if err := SaveSettingsTo(path, DefaultSettings()); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("directory holds %d entries, want only settings.json", len(entries))
	}
}
