package app

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	// Registers the decoders `image.Decode` dispatches to. Blank imports
	// because nothing here names these packages: the point is the
	// `init()`-time registration, and without them `image.Decode` recognises
	// no format at all and every paste fails as "not an image".
	//
	// PNG, JPEG and GIF are what a Windows clipboard actually carries -- the
	// webview hands us a PNG for a screenshot and whatever the source app put
	// there otherwise. WebP is not in the standard library and is not worth a
	// dependency for a format no clipboard produces.
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
)

// assetNameLayout is SPEC §6.10's `image-YYYYMMDD-HHMMSS.png`, in Go's
// reference-time spelling.
const assetNameLayout = "20060102-150405"

// defaultAssetFolder matches DefaultSettings. Repeated rather than referenced
// because it is the fallback for a settings file that names an *empty* folder,
// which is a different question from what a fresh install gets.
const defaultAssetFolder = "assets"

// maxImageBytes caps what a single paste may write.
//
// The clipboard is arbitrary content the app did not produce, and the whole
// payload crosses IPC as a base64 string before any of it is examined -- so
// without a cap a pathological image is a hang rather than an error. A 4K
// screenshot is a few megabytes; 64 MiB is far above any real paste and far
// below anything that would wedge the app.
//
// A var rather than a const so a test can lower it. That is not a decorative
// distinction: the only payload that trips this at its real value is a *valid*
// image over 64 MiB, because anything else is refused by the decoder first --
// and building one costs a 64 MiB allocation and a slow encode. Left as a const,
// the guard could be deleted with the suite still green, which is exactly how
// this was found.
var maxImageBytes = 64 << 20

// assetFolder is the folder images are written to, from settings.
//
// Reads Go's own settings rather than taking the folder from the frontend.
// Go already owns settings.json, so ferrying `files.assetFolder` through the
// store would add a second copy that can go stale, and would mean Checkpoint
// H's settings dialog has to remember to update it.
func (a *App) assetFolder() string {
	settings, err := a.LoadSettings()
	// LoadSettingsFrom never fails on bad input -- a corrupt file comes back as
	// defaults -- so an error here means the path itself could not be resolved.
	// The default folder is still the right answer; there is nothing to save
	// otherwise.
	if err != nil || settings.Files.AssetFolder == "" {
		return defaultAssetFolder
	}
	return settings.Files.AssetFolder
}

// SaveClipboardImage writes a pasted image next to docPath and returns the
// document-relative path to put in the markdown (SPEC §6.10).
//
// The bytes arrive base64-encoded because Wails' IPC is JSON; there is no
// binary channel to a bound method.
func (a *App) SaveClipboardImage(docPath, dataBase64 string) (string, error) {
	// DecodedLen is an upper bound, which is all that is needed: it refuses the
	// oversized payload before allocating the decoded copy of it.
	if base64.StdEncoding.DecodedLen(len(dataBase64)) > maxImageBytes {
		return "", errors.New("save image: too large")
	}

	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return "", fmt.Errorf("save image: %w", err)
	}

	return writeClipboardImage(docPath, a.assetFolder(), raw)
}

// SaveDroppedImage puts a dropped image file where the document can reference
// it, and returns the document-relative path for the markdown.
//
// Usually that means copying it into the asset folder, so the document and its
// images travel together. A file that already lives beside the document is
// referenced where it is -- see `copyImageFile`.
func (a *App) SaveDroppedImage(docPath, sourcePath string) (string, error) {
	return copyImageFile(docPath, a.assetFolder(), sourcePath)
}

// assetDir resolves the directory images go in, and refuses a settings file
// that points it somewhere else.
//
// `filepath.IsLocal` is the whole containment check, and it is the standard
// library's rather than a copy of the one in assets.go: it rejects absolute
// paths, volume-relative ones like `C:x`, anything that climbs out with `..`,
// the empty string, and -- the case a hand-rolled check tends to miss -- Windows
// reserved device names such as `NUL` and `COM1`.
//
// This matters because `assetFolder` comes from settings.json, which is a plain
// file the user may edit. `"assetFolder": "../../"` must not turn a paste into
// a write outside the document's directory.
func assetDir(docPath, assetFolder string) (dir, relative string, err error) {
	// The frontend prompts to save an untitled document before it gets here
	// (SPEC §6.10 step 1), so an empty path should never arrive -- but this is
	// the trust boundary, and "there is nowhere to write" is exactly the
	// condition worth refusing explicitly.
	if docPath == "" || !filepath.IsAbs(docPath) {
		return "", "", errors.New("save image: the document has no folder to write beside")
	}
	if !filepath.IsLocal(assetFolder) {
		return "", "", fmt.Errorf("save image: asset folder %q is not inside the document's folder", assetFolder)
	}

	return filepath.Join(filepath.Dir(docPath), assetFolder), assetFolder, nil
}

// createUnique makes a file that did not exist, adding `-2`, `-3`, ... to the
// stem until one sticks.
//
// `O_EXCL` rather than a stat-then-create: two pastes in the same second
// produce the same timestamped name, and checking for existence first leaves a
// window in which both see "free" and the second overwrites the first. The
// kernel settles it here instead.
//
// Returns the open file and the base name actually used.
func createUnique(dir, stem, ext string) (*os.File, string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, "", fmt.Errorf("save image: %w", err)
	}

	// Bounded rather than `for {}`: if something else is wrong -- a permission
	// error misreported as EEXIST by some filesystem, say -- an unbounded loop
	// would spin forever inside a paste. 1000 collisions on one stem is already
	// far past anything real.
	for attempt := 1; attempt <= 1000; attempt++ {
		name := stem + ext
		if attempt > 1 {
			name = stem + "-" + strconv.Itoa(attempt) + ext
		}

		file, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return file, name, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", fmt.Errorf("save image: %w", err)
		}
	}

	return nil, "", errors.New("save image: no free filename")
}

// writeClipboardImage decodes the pasted bytes and re-encodes them as a PNG.
//
// **Decoding is not a formality.** SPEC §6.10 says to write a PNG, and the
// clipboard may hold a JPEG or a GIF, so a re-encode is what makes the `.png`
// name true. It also validates: without it this method writes arbitrary
// attacker-influenced bytes to a file on disk under a name the preview will
// happily serve back. Decoding proves the payload is an image before any of it
// is written.
func writeClipboardImage(docPath, assetFolder string, raw []byte) (string, error) {
	// No size check here. `SaveClipboardImage` refuses an oversized payload
	// before it decodes the base64, which is strictly earlier and the only
	// caller -- a second check on the decoded bytes could not be reached with
	// the first in place, and neither could be tested while both existed.
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("save image: not a recognised image: %w", err)
	}

	dir, relative, err := assetDir(docPath, assetFolder)
	if err != nil {
		return "", err
	}

	file, name, err := createUnique(dir, "image-"+time.Now().Format(assetNameLayout), ".png")
	if err != nil {
		return "", err
	}

	if err := png.Encode(file, decoded); err != nil {
		file.Close()
		os.Remove(filepath.Join(dir, name))
		return "", fmt.Errorf("save image: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(filepath.Join(dir, name))
		return "", fmt.Errorf("save image: %w", err)
	}

	return markdownPath(relative, name), nil
}

// copyImageFile copies a dropped image into the asset folder.
//
// It keeps the original name and extension rather than timestamping: a dropped
// file already has a name its owner chose, and `diagram.png` in the markdown
// source is worth more than `image-20260821-094500.png`. The clipboard has no
// name to keep, which is why that path is the one SPEC gives a naming rule for.
//
// A file that is **already inside the document's own folder** is referenced
// where it sits instead of copied. Dragging an image out of the folder the
// document lives in -- from the very Explorer window it was opened from -- is
// ordinary, and copying it would leave two identical files side by side, one of
// them named `photo-2.png`.
func copyImageFile(docPath, assetFolder, sourcePath string) (string, error) {
	if !filepath.IsAbs(sourcePath) {
		return "", errors.New("save image: dropped file has no absolute path")
	}
	if !imageExtensions[strings.ToLower(filepath.Ext(sourcePath))] {
		return "", fmt.Errorf("save image: %s is not an image", filepath.Base(sourcePath))
	}

	dir, relative, err := assetDir(docPath, assetFolder)
	if err != nil {
		return "", err
	}

	// Already beside the document? Reference it in place. `filepath.Rel` gives
	// the path from the document's folder to the file, and `IsLocal` is the same
	// containment question as everywhere else here -- a result that climbs out
	// with `..` means the file is somewhere else and must be copied.
	docDir := filepath.Dir(docPath)
	if existing, relErr := filepath.Rel(docDir, sourcePath); relErr == nil && filepath.IsLocal(existing) {
		return filepath.ToSlash(existing), nil
	}

	source, err := os.Open(sourcePath)
	if err != nil {
		return "", fmt.Errorf("save image: %w", err)
	}
	defer source.Close()

	stem := filepath.Base(sourcePath)
	ext := filepath.Ext(stem)
	file, name, err := createUnique(dir, stem[:len(stem)-len(ext)], ext)
	if err != nil {
		return "", err
	}

	if _, err := io.Copy(file, source); err != nil {
		file.Close()
		os.Remove(filepath.Join(dir, name))
		return "", fmt.Errorf("save image: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(filepath.Join(dir, name))
		return "", fmt.Errorf("save image: %w", err)
	}

	return markdownPath(relative, name), nil
}

// markdownPath joins the folder and the filename with forward slashes.
//
// `path`, not `filepath`: this string goes into a markdown document, where a
// backslash is an escape character rather than a separator. A Windows-built
// `assets\pic.png` would render as `assetspic.png`.
func markdownPath(folder, name string) string {
	return path.Join(filepath.ToSlash(folder), name)
}
