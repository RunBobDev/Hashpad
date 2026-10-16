//go:build windows

package platform

import (
	"errors"
	"sort"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PLATFORM: the installed font families for the settings dialog's font
// dropdowns (design §4.37), from GDI. GDI's list is not the renderer's, so it
// is cut down here: raster and vector fonts (WebView2 draws neither), fonts
// listed only under the symbol character set, names GDI cut at 31 characters,
// and icon fonts with no letters. All of that is answered by GDI itself, in
// this process -- measuring fonts in the page instead loaded every one into
// the renderer, 35 MB for the session (measured).

var (
	gdi32               = windows.NewLazySystemDLL("gdi32.dll")
	user32              = windows.NewLazySystemDLL("user32.dll")
	enumFontFamiliesExW = gdi32.NewProc("EnumFontFamiliesExW")
	createFontIndirectW = gdi32.NewProc("CreateFontIndirectW")
	selectObject        = gdi32.NewProc("SelectObject")
	deleteObject        = gdi32.NewProc("DeleteObject")
	getGlyphIndicesW    = gdi32.NewProc("GetGlyphIndicesW")
	getDC               = user32.NewProc("GetDC")
	releaseDC           = user32.NewProc("ReleaseDC")
)

// logFont is LOGFONTW.
type logFont struct {
	height, width, escapement, orientation, weight int32
	italic, underline, strikeOut, charSet          byte
	outPrecision, clipPrecision, quality, pitch    byte
	faceName                                       [lfFaceSize]uint16
}

const (
	lfFaceSize         = 32
	defaultCharset     = 1
	symbolCharset      = 2
	fixedPitch         = 1
	truetypeFontType   = 4 // OpenType fonts are enumerated as TrueType too
	ggiMarkNonexisting = 1
	missingGlyph       = 0xFFFF
)

// fontEntry is one of GDI's answers: a family under one character set.
type fontEntry struct {
	name    string
	outline bool
	symbol  bool
	fixed   bool
}

var (
	// One callback for the process: Go can only ever create a limited number,
	// and the dialog may ask more than once. The mutex guards the slice.
	enumMu    sync.Mutex
	enumFound []fontEntry
	enumProc  = syscall.NewCallback(func(lf *logFont, _ uintptr, fontType uint32, _ uintptr) uintptr {
		enumFound = append(enumFound, fontEntry{
			name:    windows.UTF16ToString(lf.faceName[:]),
			outline: fontType&truetypeFontType != 0,
			symbol:  lf.charSet == symbolCharset,
			fixed:   lf.pitch&3 == fixedPitch,
		})
		return 1 // keep going
	})
)

func (p *windowsPlatform) InstalledFonts() ([]Font, error) {
	hdc, _, _ := getDC.Call(0)
	if hdc == 0 {
		return nil, errors.New("installed fonts: no screen device context")
	}
	defer releaseDC.Call(0, hdc)

	enumMu.Lock()
	defer enumMu.Unlock()
	enumFound = nil
	query := logFont{charSet: defaultCharset}
	enumFontFamiliesExW.Call(hdc, uintptr(unsafe.Pointer(&query)), enumProc, 0, 0)
	return familyFonts(enumFound, func(name string) bool { return hasLetters(hdc, name) }), nil
}

// familyFonts is GDI's answer as the dropdowns want it: each family once,
// sorted, kept only if text can use it. hasLetters is asked last, because it
// is the one check that opens the font (about 3 ms each, measured).
func familyFonts(entries []fontEntry, hasLetters func(name string) bool) []Font {
	type family struct{ outline, text, fixed bool }
	families := map[string]*family{}
	names := []string{}
	for _, entry := range entries {
		// "@" is GDI's twin of a CJK font for setting text sideways.
		if entry.name == "" || entry.name[0] == '@' {
			continue
		}
		f := families[entry.name]
		if f == nil {
			f = &family{}
			families[entry.name] = f
			names = append(names, entry.name)
		}
		f.outline = f.outline || entry.outline
		f.text = f.text || !entry.symbol
		f.fixed = f.fixed || entry.fixed
	}
	sort.Strings(names)

	fonts := []Font{}
	for _, name := range names {
		f := families[name]
		// A name as long as GDI allows was very likely cut short to fit, and a
		// cut name is no font the renderer knows.
		cut := len(utf16.Encode([]rune(name))) >= lfFaceSize-1
		if !f.outline || !f.text || cut || !hasLetters(name) {
			continue
		}
		fonts = append(fonts, Font{Name: name, Monospaced: f.fixed})
	}
	return fonts
}

// hasLetters reports whether name has glyphs for "a" and "W". Icon fonts
// (Segoe MDL2 Assets, Segoe Fluent Icons) look like text fonts in every flag
// GDI enumerates, and have none.
func hasLetters(hdc uintptr, name string) bool {
	query := logFont{charSet: defaultCharset}
	copy(query.faceName[:lfFaceSize-1], utf16.Encode([]rune(name)))
	font, _, _ := createFontIndirectW.Call(uintptr(unsafe.Pointer(&query)))
	if font == 0 {
		return false
	}
	defer deleteObject.Call(font)
	previous, _, _ := selectObject.Call(hdc, font)
	defer selectObject.Call(hdc, previous)

	text := utf16.Encode([]rune("aW"))
	glyphs := make([]uint16, len(text))
	getGlyphIndicesW.Call(hdc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)),
		uintptr(unsafe.Pointer(&glyphs[0])), ggiMarkNonexisting)
	for _, glyph := range glyphs {
		if glyph == missingGlyph {
			return false
		}
	}
	return true
}
