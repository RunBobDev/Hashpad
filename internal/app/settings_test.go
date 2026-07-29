package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadSettingsFromMissingFileReturnsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != DefaultSettings() {
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
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

// A corrupt settings file must not brick the app, and must not be destroyed —
// the user may want to recover what was in it (SPEC §6.13).
func TestLoadSettingsFromMalformedFileBacksUpAndFallsBack(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte("{not valid json"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("malformed settings must not return an error, got %v", err)
	}
	if got != DefaultSettings() {
		t.Errorf("got %+v, want defaults", got)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var backups int
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "settings.json.bak-") {
			backups++
		}
	}
	if backups != 1 {
		t.Errorf("expected exactly 1 backup file, found %d", backups)
	}

	// The original bad content must survive somewhere.
	if _, err := os.Stat(path); err == nil {
		data, _ := os.ReadFile(path)
		if string(data) == "{not valid json" {
			t.Error("bad file was left in place rather than backed up")
		}
	}
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
