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

// WriteFile replaces path's contents atomically. os.WriteFile opens with
// O_TRUNC, which empties the target before writing the new bytes; if the
// process dies between that truncate and the close — a crash, power loss, or
// a forced kill — the old contents are already gone and the new ones are
// incomplete. That is silent data loss in an editor whose whole promise is
// that files on disk are safe.
//
// Instead we write the new content to a temp file created in the *same*
// directory as the target (same directory means same volume, which is what
// makes the rename below atomic — a rename across volumes is not atomic and
// can fail outright) and then rename it over the target. The rename is a
// single filesystem operation: the target either still holds the old,
// complete file or the new, complete one, never a partial write. Do not
// simplify this back to os.WriteFile.
//
// Trade-off, and an acceptable one: replacing by rename swaps the file's
// inode, so hard links to the old file break, and the new file gets default
// permissions rather than inheriting the original's. For a markdown editor
// that matches the behaviour of most other editors.
func (a *App) WriteFile(path, content string, enc Encoding, ending LineEnding) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	tmpPath := tmp.Name()

	// Match the permissions os.WriteFile used to create files with; CreateTemp
	// defaults to a much more restrictive 0600.
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write %s: %w", path, err)
	}

	renamed := false
	defer func() {
		if !renamed {
			os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(Encode(content, enc, ending)); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}

	// Close before renaming: Windows refuses to rename a file that is still open.
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	renamed = true

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
	// Wails returns a nil slice (not an empty one) when the user cancels, and a
	// nil []string marshals to JSON null. The generated TypeScript binding
	// declares Promise<Array<string>>, so a caller doing paths.length on a
	// cancel — the most common outcome — would hit a runtime TypeError. Keep
	// the doc comment's promise of "an empty slice" true instead of weakening
	// it to match the bug.
	if paths == nil {
		paths = []string{}
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
