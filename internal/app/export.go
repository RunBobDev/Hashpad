package app

import (
	"fmt"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// exportKinds are the files Export can write (SPEC §7.3). PDF is not one: it
// goes through the system print dialog, which brings its own.
var exportKinds = map[string]struct {
	filters []runtime.FileFilter
	ext     string
}{
	"html": {
		filters: []runtime.FileFilter{
			{DisplayName: "Web page (*.html)", Pattern: "*.html;*.htm"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
		ext: ".html",
	},
	"text": {
		filters: []runtime.FileFilter{
			{DisplayName: "Text (*.txt)", Pattern: "*.txt"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
		ext: ".txt",
	},
}

// ShowExportDialog returns "" if the user cancelled. The file itself is
// written with WriteFile, so an export is as atomic as a save.
func (a *App) ShowExportDialog(suggestedName, kind string) (string, error) {
	k, ok := exportKinds[kind]
	if !ok {
		return "", fmt.Errorf("export dialog: unknown kind %q", kind)
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export",
		DefaultFilename: suggestedName,
		Filters:         k.filters,
	})
	if err != nil {
		return "", fmt.Errorf("export dialog: %w", err)
	}

	// Same reason as ShowSaveDialog: Windows' dialog does not always append
	// the filter's extension.
	if path != "" && filepath.Ext(path) == "" {
		path += k.ext
	}
	return path, nil
}
