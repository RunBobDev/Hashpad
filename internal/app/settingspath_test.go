package app

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// asExecutable points SettingsPath's beside-the-executable branch at dir, and
// restores the real one afterwards. Without it the branch writes next to the
// test binary, which is a real directory belonging to the Go build cache.
func asExecutable(t *testing.T, dir string) {
	t.Helper()

	previous := executable
	executable = func() (string, error) { return filepath.Join(dir, "Hashpad.exe"), nil }
	t.Cleanup(func() { executable = previous })
}

// asPortableBuild flips the link-time marker for one test.
func asPortableBuild(t *testing.T) {
	t.Helper()

	previous := portableBuild
	portableBuild = "true"
	t.Cleanup(func() { portableBuild = previous })
}

// The installed build's normal case: nothing beside the executable, so settings
// live under the user's config directory and the executable's folder is left
// completely alone.
func TestSettingsPathUsesConfigDirWhenNotPortable(t *testing.T) {
	beside := t.TempDir()
	config := t.TempDir()
	asExecutable(t, beside)
	t.Setenv("APPDATA", config)

	got, err := SettingsPath()
	if err != nil {
		t.Fatalf("settings path: %v", err)
	}

	if want := filepath.Join(config, "Hashpad", settingsFileName); got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
	if entries, _ := os.ReadDir(beside); len(entries) != 0 {
		t.Errorf("the executable's folder was written to: %v", entries)
	}
}

// SPEC §6.13's escape hatch, and it is not conditional on the build: dropping
// the file beside any Hashpad.exe by hand makes that copy portable.
func TestSettingsPathPrefersAnExistingFileBesideTheExecutable(t *testing.T) {
	beside := t.TempDir()
	asExecutable(t, beside)
	t.Setenv("APPDATA", t.TempDir())
	existing := filepath.Join(beside, settingsFileName)
	if err := SaveSettingsTo(existing, DefaultSettings()); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := SettingsPath()
	if err != nil {
		t.Fatalf("settings path: %v", err)
	}

	if got != existing {
		t.Errorf("path = %q, want %q", got, existing)
	}
}

// The portable build's whole point: a bare downloaded exe keeps to its own
// folder from the first launch, without the user knowing to create anything.
func TestPortableBuildSeedsSettingsBesideTheExecutable(t *testing.T) {
	beside := t.TempDir()
	asExecutable(t, beside)
	asPortableBuild(t)
	t.Setenv("APPDATA", t.TempDir())

	got, err := SettingsPath()
	if err != nil {
		t.Fatalf("settings path: %v", err)
	}

	want := filepath.Join(beside, settingsFileName)
	if got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
	seeded, err := LoadSettingsFrom(want)
	if err != nil {
		t.Fatalf("read the seeded file: %v", err)
	}
	if !reflect.DeepEqual(seeded, DefaultSettings()) {
		t.Errorf("seeded file is not the defaults:\n got %+v\nwant %+v", seeded, DefaultSettings())
	}
}

// **The one that matters.** Seeding runs on every launch, not just the first,
// so a version that wrote unconditionally would hand the user defaults every
// time they restarted -- silently discarding every setting they had changed.
func TestPortableBuildDoesNotOverwriteSettingsThatExist(t *testing.T) {
	beside := t.TempDir()
	asExecutable(t, beside)
	asPortableBuild(t)
	t.Setenv("APPDATA", t.TempDir())

	edited := DefaultSettings()
	edited.Appearance.Theme = "dark"
	edited.Editor.TabSize = 8
	path := filepath.Join(beside, settingsFileName)
	if err := SaveSettingsTo(path, edited); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := SettingsPath(); err != nil {
		t.Fatalf("settings path: %v", err)
	}

	after, err := LoadSettingsFrom(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !reflect.DeepEqual(after, edited) {
		t.Errorf("settings were overwritten:\n got %+v\nwant %+v", after, edited)
	}
}

// A portable exe run from somewhere it cannot write -- a read-only share, a
// locked-down directory -- still has to start. It stops being portable, which
// is the honest outcome, rather than failing to find its settings at all.
func TestPortableBuildFallsBackWhenItCannotWriteBesideTheExecutable(t *testing.T) {
	// A file where the executable's directory should be, so MkdirAll inside
	// SaveSettingsTo cannot succeed and no permission juggling is needed.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	config := t.TempDir()
	asExecutable(t, filepath.Join(blocker, "nested"))
	asPortableBuild(t)
	t.Setenv("APPDATA", config)

	got, err := SettingsPath()
	if err != nil {
		t.Fatalf("settings path: %v", err)
	}

	if want := filepath.Join(config, "Hashpad", settingsFileName); got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
}

// Guards the one thing about the portable build that fails silently.
//
// `go build -ldflags "-X wrong/path.portableBuild=true"` is not an error: the
// linker ignores a symbol it cannot find and the build succeeds, producing an
// executable that is simply not portable. Measured, not assumed -- a
// deliberately misspelled package path produced "false" and no diagnostic.
//
// So the portable build's own task runs this with the same ldflags it ships
// with, and HASHPAD_EXPECT_PORTABLE=true. An ordinary `go test` skips it,
// because there the marker is meant to be unset.
func TestPortableMarkerMatchesTheBuild(t *testing.T) {
	want := os.Getenv("HASHPAD_EXPECT_PORTABLE")
	if want == "" {
		t.Skip("set HASHPAD_EXPECT_PORTABLE to check that -ldflags reached the marker")
	}

	if portableBuild != want {
		t.Fatalf("portableBuild = %q, want %q — the -ldflags -X symbol path is wrong, "+
			"and the linker will not tell you", portableBuild, want)
	}
}
