//go:build windows

package platform

import (
	"errors"
	"sort"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PLATFORM: the installed font families, for the settings dialog's font
// dropdowns (design §4.37), from GDI's EnumFontFamiliesExW. GDI's names are
// not quite the renderer's -- it lists every weight as its own family, cuts
// names at 31 characters and includes raster fonts WebView2 cannot draw -- so
// the frontend keeps only what it can draw (settings/fonts.ts). DirectWrite
// has the cleaner list but is COM with no Go binding here; this is two calls.

var (
	gdi32               = windows.NewLazySystemDLL("gdi32.dll")
	user32              = windows.NewLazySystemDLL("user32.dll")
	enumFontFamiliesExW = gdi32.NewProc("EnumFontFamiliesExW")
	getDC               = user32.NewProc("GetDC")
	releaseDC           = user32.NewProc("ReleaseDC")
)

// logFont is LOGFONTW. Only the charset (to ask for every one) and the face
// name (the answer) are used.
type logFont struct {
	height, width, escapement, orientation, weight int32
	italic, underline, strikeOut, charSet          byte
	outPrecision, clipPrecision, quality, pitch    byte
	faceName                                       [32]uint16
}

const defaultCharset = 1

var (
	// One callback for the process: Go can only ever create a limited number,
	// and the dialog may ask many times. The mutex makes the shared slice safe.
	enumMu    sync.Mutex
	enumFound []string
	enumProc  = syscall.NewCallback(func(lf *logFont, _ uintptr, _ uint32, _ uintptr) uintptr {
		enumFound = append(enumFound, windows.UTF16ToString(lf.faceName[:]))
		return 1 // keep going
	})
)

func (p *windowsPlatform) InstalledFonts() ([]string, error) {
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
	return familyNames(enumFound), nil
}

// familyNames is GDI's answer as a list: each family once, sorted, without the
// "@" twins GDI reports for setting CJK text sideways.
func familyNames(raw []string) []string {
	seen := map[string]bool{}
	names := []string{}
	for _, name := range raw {
		if name == "" || name[0] == '@' || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
