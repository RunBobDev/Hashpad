package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLoadSettingsFromMissingFileReturnsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(got, DefaultSettings()) {
		t.Errorf("got %+v, want defaults", got)
	}
}

func TestLoadSettingsFromValidFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	want := DefaultSettings()
	want.Editor.FontSize = 18
	want.Appearance.Theme = "dark"

	if err := SaveSettingsTo(path, want); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

// A corrupt settings file must not brick the app, and must not be destroyed —
// the user may want to recover what was in it (SPEC §6.13).
func TestLoadSettingsFromMalformedFileBacksUpAndFallsBack(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(malformedSettings), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("malformed settings must not return an error, got %v", err)
	}
	if !reflect.DeepEqual(got, DefaultSettings()) {
		t.Errorf("got %+v, want defaults", got)
	}

	backups := backupFiles(t, dir)
	if len(backups) != 1 {
		t.Fatalf("expected exactly 1 backup file, found %d", len(backups))
	}

	// Assert the backup's *content*, not just its existence. Checking only that
	// a .bak- file appeared would pass against an implementation that deleted
	// the bad file and touched an empty marker — losing the user's hand-edited
	// config while reporting success, the worst outcome this code can produce.
	backedUp := readFile(t, filepath.Join(dir, backups[0]))
	if backedUp != malformedSettings {
		t.Errorf("backup content = %q, want the original bad bytes %q", backedUp, malformedSettings)
	}
}

// A directory where settings.json should be is unreadable but is not
// "not found", so it takes a different branch. It must still not brick the app.
func TestLoadSettingsFromUnreadablePathReturnsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("an unreadable settings path must not return an error, got %v", err)
	}
	if !reflect.DeepEqual(got, DefaultSettings()) {
		t.Errorf("got %+v, want defaults", got)
	}
}

// The timestamp in a backup name has one-second resolution and os.Rename
// overwrites silently on Windows, so a second bad load in the same second used
// to destroy the first backup. Pre-creating the exact name the code is about to
// choose forces the collision deterministically rather than hoping for it.
func TestBackupNeverOverwritesAnExistingBackup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	occupied := fmt.Sprintf("%s.bak-%s", path, time.Now().Format("20060102-150405"))
	const existing = "an earlier backup that must survive"
	if err := os.WriteFile(occupied, []byte(existing), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := os.WriteFile(path, []byte(malformedSettings), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := LoadSettingsFrom(path); err != nil {
		t.Fatalf("load: %v", err)
	}

	if got := readFile(t, occupied); got != existing {
		t.Errorf("the pre-existing backup was clobbered: got %q, want %q", got, existing)
	}
	if backups := backupFiles(t, dir); len(backups) != 2 {
		t.Errorf("expected 2 backups (the seeded one and the new one), found %d", len(backups))
	}
}

func TestSaveThenLoadRoundTripsNonDefaultValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")

	want := DefaultSettings()
	want.Appearance.Theme = "dark"
	want.Appearance.AccentColor = "#c50f1f"
	want.Editor.FontFamily = "JetBrains Mono"
	want.Editor.WordWrap = false
	want.Editor.LineHeight = 1.85
	want.Preview.SyncScroll = false
	want.Files.Autosave = true
	want.Window.PreviewSplitRatio = 0.35
	want.Window.Maximized = true

	if err := SaveSettingsTo(path, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("round trip changed settings:\n got %+v\nwant %+v", got, want)
	}
}

const malformedSettings = "{not valid json"

func backupFiles(t *testing.T, dir string) []string {
	t.Helper()

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}

	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "settings.json.bak-") {
			names = append(names, e.Name())
		}
	}
	return names
}

func readFile(t *testing.T, path string) string {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func TestLoadSettingsFromUnknownVersionFallsBackToDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	raw := `{"version": 999, "editor": {"fontSize": 42}}`
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Editor.FontSize != DefaultSettings().Editor.FontSize {
		t.Errorf("fontSize = %d, want default %d", got.Editor.FontSize, DefaultSettings().Editor.FontSize)
	}
}

// Partial files are normal — a user hand-editing settings.json will omit keys.
// Missing keys must take their default, not Go's zero value.
func TestLoadSettingsFromPartialFileFillsDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	raw := `{"version": 1, "editor": {"fontSize": 20}}`
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Editor.FontSize != 20 {
		t.Errorf("fontSize = %d, want 20", got.Editor.FontSize)
	}
	if got.Editor.TabSize != DefaultSettings().Editor.TabSize {
		t.Errorf("tabSize = %d, want default %d", got.Editor.TabSize, DefaultSettings().Editor.TabSize)
	}
	if got.Appearance.AccentColor != DefaultSettings().Appearance.AccentColor {
		t.Errorf("accentColor = %q, want default", got.Appearance.AccentColor)
	}
}

func TestSaveSettingsToCreatesParentDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dir", "settings.json")

	if err := SaveSettingsTo(path, DefaultSettings()); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("file not created: %v", err)
	}
}

func TestSavedSettingsAreReadableJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := SaveSettingsTo(path, DefaultSettings()); err != nil {
		t.Fatalf("save: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var generic map[string]any
	if err := json.Unmarshal(data, &generic); err != nil {
		t.Fatalf("saved settings are not valid JSON: %v", err)
	}
	if _, ok := generic["version"]; !ok {
		t.Error("saved settings have no version field")
	}
	// Remote image loading was removed by design; the key must not reappear.
	if preview, ok := generic["preview"].(map[string]any); ok {
		if _, found := preview["loadRemoteImages"]; found {
			t.Error("loadRemoteImages must not be in the settings schema")
		}
	}
}

// Pins SPEC §6.13's default pinned list so a later edit to DefaultSettings
// cannot quietly change what a fresh install starts with.
func TestDefaultPinnedToolbarCommands(t *testing.T) {
	want := []string{
		"bold", "italic", "strikethrough", "inlineCode", "heading",
		"bulletList", "numberedList", "taskList", "link", "table",
	}
	if got := DefaultSettings().Toolbar.Pinned; !reflect.DeepEqual(got, want) {
		t.Errorf("default pinned = %v, want %v", got, want)
	}
}
