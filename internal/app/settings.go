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
// a migration in `migrateSettings`; a version from the *future* still falls back
// to defaults, because we cannot guess at a format we do not know.
const settingsVersion = 2

// migrateSettings brings an older file forward, keeping everything it does not
// have a reason to change.
//
// **Why this is needed at all, and not only for the one value below.**
// `SaveSettings` writes the whole struct, so the first time a user changes any
// single setting -- the theme, the window size, a pinned toolbar button --
// every default in force at that moment is frozen into their file. A later
// change to `DefaultSettings` then never reaches them: the file has an explicit
// value, and an explicit value wins. Without a migration step, "change the
// default" is only ever true for a fresh install.
//
// That is exactly how this was found: design §4.19 turned the content-width cap
// off by default, and the owner reported the editor still capped, because their
// settings.json said `"maxContentWidth": 900` -- written there by a theme change
// made weeks earlier.
func migrateSettings(settings Settings) Settings {
	if settings.Version < 2 {
		// v1 shipped `maxContentWidth: 900`. Only the old default is rewritten,
		// so someone who deliberately chose 900 does lose it -- accepted,
		// because the alternative is leaving every v1 install with a cap they
		// never asked for, and there is no record of which of the two it was.
		// Any other value is a choice and is kept.
		if settings.Editor.MaxContentWidth == 900 {
			settings.Editor.MaxContentWidth = 0
		}
	}

	settings.Version = settingsVersion
	return settings
}

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
	Width          int  `json:"width"`
	Height         int  `json:"height"`
	Maximized      bool `json:"maximized"`
	OutlineVisible bool `json:"outlineVisible"`
	// OutlineWidth is in CSS pixels. SPEC §6.9 asks for the outline's width to
	// be persisted; it is a width rather than a ratio because the sidebar holds
	// text at a fixed size, so what the user is choosing is how many characters
	// of a heading they can read — not a share of the window.
	OutlineWidth      float64 `json:"outlineWidth"`
	StatusBarVisible  bool    `json:"statusBarVisible"`
	PreviewSplitRatio float64 `json:"previewSplitRatio"`
}

// ToolbarSettings carries SPEC §6.13's toolbar block. Pinned is a slice, which
// is what stops Settings being comparable with == — see settings_test.go, where
// the comparisons use reflect.DeepEqual for exactly this reason.
type ToolbarSettings struct {
	Visible bool     `json:"visible"`
	Pinned  []string `json:"pinned"`
}

// Settings is no longer comparable with == — ToolbarSettings.Pinned is a
// slice, and a struct containing one is not comparable. Tests must use
// reflect.DeepEqual instead of == or !=.
type Settings struct {
	Version    int                `json:"version"`
	Appearance AppearanceSettings `json:"appearance"`
	Editor     EditorSettings     `json:"editor"`
	Preview    PreviewSettings    `json:"preview"`
	Files      FilesSettings      `json:"files"`
	Window     WindowSettings     `json:"window"`
	Toolbar    ToolbarSettings    `json:"toolbar"`
}

func DefaultSettings() Settings {
	return Settings{
		Version: settingsVersion,
		Appearance: AppearanceSettings{
			Theme: "system", AccentColor: "#0078d4", UIFontSize: 14,
		},
		Editor: EditorSettings{
			FontFamily: "Cascadia Mono", FontSize: 14, LineHeight: 1.6,
			// MaxContentWidth 0 means "no limit", and that is the default
			// despite SPEC §6.13's example block showing 900 (design §4.15).
			// §6.1's prose calls it an "*optional* max content width", and the
			// owner reported the capped column as a defect twice: text stopped
			// growing partway across the window and left a wide empty gap. A
			// measure is a preference, not a default. The setting still works;
			// it is off until asked for.
			WordWrap: true, MaxContentWidth: 0, ShowLineNumbers: false,
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
			OutlineWidth: 240,
		},
		Toolbar: ToolbarSettings{
			Visible: true,
			Pinned: []string{
				"bold", "italic", "strikethrough", "inlineCode", "heading",
				"bulletList", "numberedList", "taskList", "link", "table",
			},
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
		// Unreadable for some other reason — a directory at the settings path,
		// a permissions problem, a bad mount. Treated exactly like a corrupt
		// file: log and carry on with defaults. Returning an error here would
		// brick the editor over its own config, which SPEC §6.13 forbids. No
		// backup is attempted because there is nothing readable to preserve.
		log.Printf("hashpad: cannot read settings at %s (%v); using defaults", path, err)
		return DefaultSettings(), nil
	}

	// Start from defaults so keys the file omits keep their default rather than
	// decoding to Go's zero value — a hand-edited file is normally partial.
	settings := DefaultSettings()
	if err := json.Unmarshal(data, &settings); err != nil {
		log.Printf("hashpad: settings at %s are malformed (%v); using defaults", path, err)
		backupBadSettings(path)
		return DefaultSettings(), nil
	}

	// A file from an older schema is upgraded, not discarded. Throwing it away
	// would cost the user their theme, window size and pinned toolbar to change
	// one field, which is a worse answer than migrating -- and it would make
	// bumping the version something to avoid rather than the routine step the
	// constant's comment describes.
	//
	// A version from the *future* is still replaced: it was written by a build
	// that knew a format this one does not, and guessing at it is how settings
	// get silently mangled. `0` and anything negative land here too, which is
	// right -- neither is a schema this code has ever written.
	if settings.Version > 0 && settings.Version < settingsVersion {
		log.Printf("hashpad: migrating settings at %s from version %d to %d",
			path, settings.Version, settingsVersion)
		return migrateSettings(settings), nil
	}

	if settings.Version != settingsVersion {
		log.Printf("hashpad: settings at %s have version %d, expected %d; using defaults",
			path, settings.Version, settingsVersion)
		backupBadSettings(path)
		return DefaultSettings(), nil
	}

	return settings, nil
}

// maxBackupAttempts bounds the search for an unused backup name so a
// pathological directory cannot spin here. Reaching it means giving up rather
// than clobbering something.
const maxBackupAttempts = 100

// backupBadSettings moves the offending file aside so the user can recover what
// they had. Best effort: if it fails there is nothing useful to do beyond
// logging, and the caller still gets working defaults.
func backupBadSettings(path string) {
	backup, err := unusedBackupPath(path)
	if err != nil {
		log.Printf("hashpad: could not back up %s: %v", path, err)
		return
	}
	if err := os.Rename(path, backup); err != nil {
		log.Printf("hashpad: could not back up %s: %v", path, err)
		return
	}
	log.Printf("hashpad: previous settings saved to %s", backup)
}

// unusedBackupPath finds a backup name nothing occupies yet.
//
// The existence check is load-bearing, not belt-and-braces: the timestamp has
// one-second resolution and os.Rename silently overwrites an existing
// destination on Windows, so two bad loads in the same second would destroy the
// first backup — overwriting the very thing SPEC §6.13 says to preserve.
func unusedBackupPath(path string) (string, error) {
	base := fmt.Sprintf("%s.bak-%s", path, time.Now().Format("20060102-150405"))

	candidate := base
	for attempt := 2; attempt <= maxBackupAttempts; attempt++ {
		if _, err := os.Stat(candidate); errors.Is(err, fs.ErrNotExist) {
			return candidate, nil
		}
		candidate = fmt.Sprintf("%s-%d", base, attempt)
	}
	return "", fmt.Errorf("no unused backup name near %s after %d attempts", base, maxBackupAttempts)
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

// ResetSettings writes the compiled-in defaults over the user's file and hands
// them back, for the settings dialog's Reset button.
//
// It lives here rather than in the frontend because DefaultSettings is the one
// definition of what "default" means. A TypeScript copy of that table would be
// a second one, and the two would drift the first time a default changed --
// which is not hypothetical: `migrateSettings` above exists precisely because a
// default changed and the owner did not get it.
//
// Returns the settings as well as writing them, so the caller re-applies
// exactly what is now on disk rather than its own idea of the defaults.
//
// The error is what the frontend sees: Wails maps a `(T, error)` method onto a
// promise that *rejects* on a non-nil error and discards the value, so the
// defaults returned alongside one never cross the bridge. That is the right
// behaviour here anyway -- a reset that appeared to work and quietly did not
// persist is worse than one that visibly failed and changed nothing -- and
// frontend/src/main.ts's handler leaves the running app untouched on a
// rejection. The pair is still returned for the Go-side caller and its test.
func (a *App) ResetSettings() (Settings, error) {
	defaults := DefaultSettings()

	path, err := SettingsPath()
	if err != nil {
		return defaults, err
	}
	return defaults, SaveSettingsTo(path, defaults)
}
