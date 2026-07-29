package app

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// FileContents is what the frontend receives for an opened file. It never sees
// bytes — Go owns the encoding round trip entirely (SPEC §3.1).
type FileContents struct {
	Path       string     `json:"path"`
	Content    string     `json:"content"`
	Encoding   Encoding   `json:"encoding"`
	LineEnding LineEnding `json:"lineEnding"`
	// Mixed reports that the file used both CRLF and LF. The whole file is
	// saved with the first convention found, so the status bar must be able to
	// tell the user that flattening will happen.
	Mixed bool `json:"mixed"`
}

// markdownFilters is shared by both dialogs so the open and save file-type lists
// cannot drift apart. Extensions match SPEC §6.4.
var markdownFilters = []runtime.FileFilter{
	{
		DisplayName: "Markdown (*.md, *.markdown, *.mdown, *.mkd, *.mdx, *.qmd, *.rmd)",
		Pattern:     "*.md;*.markdown;*.mdown;*.mkd;*.mdx;*.qmd;*.rmd",
	},
	{DisplayName: "Text (*.txt)", Pattern: "*.txt"},
	{DisplayName: "All files (*.*)", Pattern: "*.*"},
}

func (a *App) ReadFile(path string) (FileContents, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return FileContents{}, fmt.Errorf("read %s: %w", path, err)
	}

	content, enc, ending, mixed := Decode(raw)
	return FileContents{
		Path:       path,
		Content:    content,
		Encoding:   enc,
		LineEnding: ending,
		Mixed:      mixed,
	}, nil
}

func (a *App) WriteFile(path, content string, enc Encoding, ending LineEnding) error {
	if err := os.WriteFile(path, Encode(content, enc, ending), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// ShowOpenDialog returns the chosen paths, or an empty slice if the user
// cancelled — cancelling is a normal outcome, not an error.
func (a *App) ShowOpenDialog() ([]string, error) {
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Open",
		Filters: markdownFilters,
	})
	if err != nil {
		return nil, fmt.Errorf("open dialog: %w", err)
	}
	return paths, nil
}

// ShowSaveDialog returns "" if the user cancelled.
func (a *App) ShowSaveDialog(suggestedName string) (string, error) {
	if suggestedName == "" {
		suggestedName = "Untitled.md"
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save As",
		DefaultFilename: suggestedName,
		Filters:         markdownFilters,
	})
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}

	// Windows' dialog does not always append the filter's extension, and a
	// markdown file with no extension is a worse default than guessing .md.
	if path != "" && filepath.Ext(path) == "" {
		path += ".md"
	}
	return path, nil
}
