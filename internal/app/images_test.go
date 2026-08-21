package app

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// pngBytes is a real, decodable 2x1 PNG. The tests need genuine image data
// rather than a magic-number prefix, because the code under test decodes what
// it is given -- that is the point of it.
func pngBytes(t *testing.T) []byte {
	t.Helper()

	img := image.NewRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	img.Set(1, 0, color.RGBA{B: 255, A: 255})

	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}

func jpegBytes(t *testing.T) []byte {
	t.Helper()

	img := image.NewRGBA(image.Rect(0, 0, 2, 1))
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, img, nil); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buffer.Bytes()
}

/** A document path inside a fresh temp directory. */
func docIn(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "notes.md")
}

func TestWriteClipboardImageNamesAndPlacesTheFile(t *testing.T) {
	doc := docIn(t)

	got, err := writeClipboardImage(doc, "assets", pngBytes(t))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// SPEC §6.10 step 3/4: `assets/image-YYYYMMDD-HHMMSS.png`, with forward
	// slashes because this string goes into a markdown document.
	if !regexp.MustCompile(`^assets/image-\d{8}-\d{6}\.png$`).MatchString(got) {
		t.Errorf("markdown path = %q, want assets/image-YYYYMMDD-HHMMSS.png", got)
	}

	// And the folder was created on demand (SPEC §6.10 step 2).
	written := filepath.Join(filepath.Dir(doc), filepath.FromSlash(got))
	if _, err := os.Stat(written); err != nil {
		t.Fatalf("stat written file: %v", err)
	}
}

// Two pastes inside the same second produce the same timestamp. Without the
// O_EXCL loop the second would silently overwrite the first -- the user's
// previous screenshot, gone.
func TestWriteClipboardImageDoesNotOverwriteASameSecondPaste(t *testing.T) {
	doc := docIn(t)
	data := pngBytes(t)

	first, err := writeClipboardImage(doc, "assets", data)
	if err != nil {
		t.Fatalf("first write: %v", err)
	}
	second, err := writeClipboardImage(doc, "assets", data)
	if err != nil {
		t.Fatalf("second write: %v", err)
	}

	if first == second {
		t.Fatalf("both pastes returned %q; the second overwrote the first", first)
	}

	entries, err := os.ReadDir(filepath.Join(filepath.Dir(doc), "assets"))
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("asset folder holds %d files, want 2", len(entries))
	}
}

// SPEC §6.10 says write a PNG. A clipboard can hold a JPEG, so the name is only
// true if the bytes are re-encoded rather than passed through.
func TestWriteClipboardImageReencodesAJpegAsPng(t *testing.T) {
	doc := docIn(t)

	got, err := writeClipboardImage(doc, "assets", jpegBytes(t))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(filepath.Dir(doc), filepath.FromSlash(got)))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if _, format, err := image.Decode(bytes.NewReader(raw)); err != nil || format != "png" {
		t.Errorf("stored format = %q (err %v), want png", format, err)
	}
}

// Decoding is the validation step: without it this writes arbitrary bytes to
// disk under a name the preview will serve back.
func TestWriteClipboardImageRefusesNonImageBytes(t *testing.T) {
	doc := docIn(t)

	if _, err := writeClipboardImage(doc, "assets", []byte("MZ\x90\x00 not an image")); err == nil {
		t.Fatal("want an error for non-image bytes")
	}

	// And nothing was left behind -- not even the folder.
	if _, err := os.Stat(filepath.Join(filepath.Dir(doc), "assets")); !os.IsNotExist(err) {
		t.Errorf("asset folder exists after a refused paste (err %v)", err)
	}
}

// settings.json is a plain file the user may edit. None of these may turn a
// paste into a write outside the document's own folder.
func TestAssetDirRefusesAnEscapingAssetFolder(t *testing.T) {
	doc := filepath.Join(t.TempDir(), "notes.md")

	cases := []struct {
		name   string
		folder string
	}{
		{"parent traversal", ".."},
		{"nested parent traversal", "assets/../.."},
		{"an absolute unix path", "/etc"},
		{"an absolute windows path", `C:\Windows`},
		{"a drive-relative windows path", "C:assets"},
		{"empty", ""},
		// The case a hand-rolled containment check misses, and the reason this
		// uses filepath.IsLocal rather than a copy of assets.go's logic.
		{"a windows device name", "NUL"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, _, err := assetDir(doc, testCase.folder); err == nil {
				t.Errorf("assetDir(%q) succeeded, want an error", testCase.folder)
			}
		})
	}
}

// SPEC §6.10 step 1 is a frontend prompt, but "there is nowhere to write" is
// exactly the condition a trust boundary should refuse rather than assume away.
func TestAssetDirRefusesADocumentWithNoFolder(t *testing.T) {
	for _, doc := range []string{"", "notes.md", `relative\notes.md`} {
		if _, _, err := assetDir(doc, "assets"); err == nil {
			t.Errorf("assetDir(%q) succeeded, want an error", doc)
		}
	}
}

// Lowers the cap rather than building a 64 MiB image, and the image is a real
// one on purpose: a buffer of zeros over the limit is refused by the decoder
// whether the cap exists or not, so testing with junk bytes cannot tell the two
// apart. An earlier version of this test did exactly that and stayed green with
// the guard deleted.
func TestSaveClipboardImageRefusesAnOversizedPayload(t *testing.T) {
	original := maxImageBytes
	maxImageBytes = 8
	defer func() { maxImageBytes = original }()

	valid := base64.StdEncoding.EncodeToString(pngBytes(t))
	app := &App{}

	if _, err := app.SaveClipboardImage(docIn(t), valid); err == nil {
		t.Fatal("want an error for a paste over the cap")
	}
}

// And the same image goes through once it is under the cap, so the test above
// is measuring the cap and not some other refusal.
func TestSaveClipboardImageAcceptsAPayloadUnderTheCap(t *testing.T) {
	if _, err := (&App{}).SaveClipboardImage(
		docIn(t), base64.StdEncoding.EncodeToString(pngBytes(t)),
	); err != nil {
		t.Fatalf("want the paste to succeed under the cap, got %v", err)
	}
}

func TestSaveClipboardImageRefusesMalformedBase64(t *testing.T) {
	app := &App{}

	if _, err := app.SaveClipboardImage(docIn(t), "!!!not base64!!!"); err == nil {
		t.Fatal("want an error for malformed base64")
	}
}

func TestCopyImageFileCopiesIntoTheAssetFolder(t *testing.T) {
	doc := docIn(t)
	source := filepath.Join(t.TempDir(), "diagram.png")
	if err := os.WriteFile(source, pngBytes(t), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	got, err := copyImageFile(doc, "assets", source)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}

	// The dropped file keeps the name its owner gave it -- `diagram.png` in the
	// markdown source is worth more than a timestamp.
	if got != "assets/diagram.png" {
		t.Errorf("markdown path = %q, want assets/diagram.png", got)
	}
	copied, err := os.ReadFile(filepath.Join(filepath.Dir(doc), "assets", "diagram.png"))
	if err != nil {
		t.Fatalf("read copy: %v", err)
	}
	if !bytes.Equal(copied, pngBytes(t)) {
		t.Error("the copy does not match the source bytes")
	}
}

func TestCopyImageFileDoesNotOverwriteAnExistingName(t *testing.T) {
	doc := docIn(t)
	source := filepath.Join(t.TempDir(), "diagram.png")
	if err := os.WriteFile(source, pngBytes(t), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	first, err := copyImageFile(doc, "assets", source)
	if err != nil {
		t.Fatalf("first copy: %v", err)
	}
	second, err := copyImageFile(doc, "assets", source)
	if err != nil {
		t.Fatalf("second copy: %v", err)
	}

	if first != "assets/diagram.png" || second != "assets/diagram-2.png" {
		t.Errorf("got %q then %q, want assets/diagram.png then assets/diagram-2.png", first, second)
	}
}

// Dragging an image out of the folder the document was opened from is ordinary.
// Copying it would leave two identical files side by side, the second named
// `photo-2.png`.
func TestCopyImageFileReferencesAFileAlreadyBesideTheDocument(t *testing.T) {
	dir := t.TempDir()
	doc := filepath.Join(dir, "notes.md")
	source := filepath.Join(dir, "assets", "already.png")
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(source, pngBytes(t), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	got, err := copyImageFile(doc, "assets", source)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}

	if got != "assets/already.png" {
		t.Errorf("markdown path = %q, want assets/already.png", got)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "assets"))
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("asset folder holds %d files, want 1 -- the file was copied over itself", len(entries))
	}
}

// A sibling *outside* the asset folder still counts as beside the document, so
// it is referenced where it sits rather than duplicated into `assets/`.
func TestCopyImageFileReferencesASiblingOfTheDocument(t *testing.T) {
	dir := t.TempDir()
	doc := filepath.Join(dir, "notes.md")
	source := filepath.Join(dir, "cover.png")
	if err := os.WriteFile(source, pngBytes(t), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	got, err := copyImageFile(doc, "assets", source)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}

	if got != "cover.png" {
		t.Errorf("markdown path = %q, want cover.png", got)
	}
}

func TestCopyImageFileRefusesWhatIsNotAnImage(t *testing.T) {
	doc := docIn(t)
	source := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(source, []byte("hello"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	if _, err := copyImageFile(doc, "assets", source); err == nil {
		t.Fatal("want an error for a non-image extension")
	}
}

// The message matters here, not just the failure. Without the IsAbs guard a
// relative source still errors -- os.Open cannot find it -- so asserting "some
// error" cannot tell the guard from an ENOENT two steps later, and deleting it
// left the suite green.
func TestCopyImageFileRefusesARelativeSource(t *testing.T) {
	_, err := copyImageFile(docIn(t), "assets", "photo.png")
	if err == nil {
		t.Fatal("want an error for a source with no absolute path")
	}
	if !strings.Contains(err.Error(), "no absolute path") {
		t.Errorf("error = %v, want it to name the missing absolute path", err)
	}
}

// The markdown string must use forward slashes: in a document a backslash is an
// escape character, so a Windows-built `assets\pic.png` renders as
// `assetspic.png`.
func TestMarkdownPathUsesForwardSlashes(t *testing.T) {
	if got := markdownPath(`img\sub`, "pic.png"); got != "img/sub/pic.png" {
		t.Errorf("markdownPath = %q, want img/sub/pic.png", got)
	}
}
