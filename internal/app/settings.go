package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"time"
)

// settingsVersion is the schema version written to disk. Bump it only alongside
// a migration; an unrecognised version falls back to defaults rather than
// guessing at a format we do not know.
const settingsVersion = 1

type AppearanceSettings struct {
	Theme       string `json:"theme"`
	AccentColor string `json:"accentColor"`
	UIFontSize  int    `json:"uiFontSize"`
}

type EditorSettings struct {
	FontFamily      string  `json:"fontFamily"`
	FontSize        int     `json:"fontSize"`
	LineHeight      float64 `json:"lineHeight"`
	WordWrap        bool    `json:"wordWrap"`
	MaxContentWidth int     `json:"maxContentWidth"`
	ShowLineNumbers bool    `json:"showLineNumbers"`
	TabSize         int     `json:"tabSize"`
	InsertSpaces    bool    `json:"insertSpaces"`
	DefaultViewMode string  `json:"defaultViewMode"`
}

// PreviewSettings has no loadRemoteImages field: remote images are never
// fetched (design §3), so the setting would be a switch wired to nothing.
type PreviewSettings struct {
	FontFamily string `json:"fontFamily"`
	FontSize   int    `json:"fontSize"`
	SyncScroll bool   `json:"syncScroll"`
}

type FilesSettings struct {
	Autosave        bool   `json:"autosave"`
	AutosaveDelayMs int    `json:"autosaveDelayMs"`
	AssetFolder     string `json:"assetFolder"`
	DefaultEncoding string `json:"defaultEncoding"`
}

type WindowSettings struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	Maximized         bool    `json:"maximized"`
	OutlineVisible    bool    `json:"outlineVisible"`
	StatusBarVisible  bool    `json:"statusBarVisible"`
	PreviewSplitRatio float64 `json:"previewSplitRatio"`
}

// Settings is comparable with == (no slices or maps), which keeps the tests
// simple. Toolbar.Pinned is deliberately deferred to Checkpoint E, which is the
// checkpoint that introduces the toolbar and therefore knows what belongs in it.
type Settings struct {
	Version    int                `json:"version"`
	Appearance AppearanceSettings `json:"appearance"`
	Editor     EditorSettings     `json:"editor"`
	Preview    PreviewSettings    `json:"preview"`
	Files      FilesSettings      `json:"files"`
	Window     WindowSettings     `json:"window"`
}

func DefaultSettings() Settings {
	return Settings{
		Version: settingsVersion,
		Appearance: AppearanceSettings{
			Theme: "system", AccentColor: "#0078d4", UIFontSize: 14,
		},
		Editor: EditorSettings{
			FontFamily: "Cascadia Mono", FontSize: 14, LineHeight: 1.6,
			WordWrap: true, MaxContentWidth: 900, ShowLineNumbers: false,
			TabSize: 2, InsertSpaces: true, DefaultViewMode: "source",
		},
		Preview: PreviewSettings{
			FontFamily: "Segoe UI", FontSize: 15, SyncScroll: true,
		},
		Files: FilesSettings{
			Autosave: false, AutosaveDelayMs: 2000,
			AssetFolder: "assets", DefaultEncoding: "utf-8",
		},
		Window: WindowSettings{
			Width: 1000, Height: 700, Maximized: false,
			OutlineVisible: false, StatusBarVisible: true, PreviewSplitRatio: 0.5,
		},
	}
}

// SettingsPath resolves where settings live. A settings.json beside the
// executable wins, which is what makes the portable build genuinely portable —
// it leaves no trace on the host machine (SPEC §6.13).
func SettingsPath() (string, error) {
	exe, err := os.Executable()
	if err == nil {
		portable := filepath.Join(filepath.Dir(exe), "settings.json")
		if _, statErr := os.Stat(portable); statErr == nil {
			return portable, nil
		}
	}

	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate user config dir: %w", err)
	}
	return filepath.Join(dir, "Hashpad", "settings.json"), nil
}

// LoadSettingsFrom never fails on bad input. A corrupt or future-versioned file
// is backed up and replaced by defaults, because bricking the editor over its
// own config file is worse than losing the config (SPEC §6.13).
func LoadSettingsFrom(path string) (Settings, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return DefaultSettings(), nil
	}
	if err != nil {
		return DefaultSettings(), fmt.Errorf("read settings %s: %w", path, err)
	}

	// Start from defaults so keys the file omits keep their default rather than
	// decoding to Go's zero value — a hand-edited file is normally partial.
	settings := DefaultSettings()
	if err := json.Unmarshal(data, &settings); err != nil {
		log.Printf("hashpad: settings at %s are malformed (%v); using defaults", path, err)
		backupBadSettings(path)
		return DefaultSettings(), nil
	}

	if settings.Version != settingsVersion {
		log.Printf("hashpad: settings at %s have version %d, expected %d; using defaults",
			path, settings.Version, settingsVersion)
		backupBadSettings(path)
		return DefaultSettings(), nil
	}

	return settings, nil
}

// backupBadSettings renames the offending file out of the way. Best effort: if
// it fails there is nothing useful to do beyond logging, and the caller still
// gets working defaults.
func backupBadSettings(path string) {
	backup := fmt.Sprintf("%s.bak-%s", path, time.Now().Format("20060102-150405"))
	if err := os.Rename(path, backup); err != nil {
		log.Printf("hashpad: could not back up %s: %v", path, err)
		return
	}
	log.Printf("hashpad: previous settings saved to %s", backup)
}

func SaveSettingsTo(path string, s Settings) error {
	s.Version = settingsVersion

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create settings dir: %w", err)
	}

	// Indented so the file stays hand-editable, which SPEC §6.13's portable
	// mode assumes people will do.
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}

	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("write settings %s: %w", path, err)
	}
	return nil
}

func (a *App) LoadSettings() (Settings, error) {
	path, err := SettingsPath()
	if err != nil {
		return DefaultSettings(), err
	}
	return LoadSettingsFrom(path)
}

func (a *App) SaveSettings(s Settings) error {
	path, err := SettingsPath()
	if err != nil {
		return err
	}
	return SaveSettingsTo(path, s)
}
