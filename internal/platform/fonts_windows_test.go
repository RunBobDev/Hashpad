//go:build windows

package platform

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

// GDI reports a family once per character set and a vertical "@" twin for CJK
// text; it lists raster and vector fonts the renderer cannot use, symbol fonts,
// names cut at 31 characters, and icon fonts with no letters (design §4.37).
func TestFamilyFontsKeepsTheFontsTextCanUse(t *testing.T) {
	entries := []fontEntry{
		{name: "Segoe UI", outline: true},
		{name: "Segoe UI", outline: true, symbol: false},
		{name: "@MS Gothic", outline: true, fixed: true},
		{name: "MS Gothic", outline: true, fixed: true},
		{name: "Arial", outline: true},
		{name: ""},
		{name: "Fixedsys", fixed: true},                          // raster
		{name: "Wingdings", outline: true, symbol: true},         // symbol charset only
		{name: "Segoe MDL2 Assets", outline: true},               // no letters
		{name: "Segoe UI Variable Display Semib", outline: true}, // cut at 31
		{name: "Consolas", outline: true},
		{name: "Consolas", outline: true, fixed: true}, // fixed under any charset is fixed
	}
	letters := func(name string) bool { return name != "Segoe MDL2 Assets" }

	got := familyFonts(entries, letters)

	want := []Font{
		{Name: "Arial"},
		{Name: "Consolas", Monospaced: true},
		{Name: "MS Gothic", Monospaced: true},
		{Name: "Segoe UI"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("familyFonts =\n%+v\nwant\n%+v", got, want)
	}
}

// A symbol charset alongside a text one is still a text font.
func TestFamilyFontsKeepsAFontWithATextCharsetToo(t *testing.T) {
	got := familyFonts([]fontEntry{
		{name: "Mixed", outline: true, symbol: true},
		{name: "Mixed", outline: true},
	}, func(string) bool { return true })
	if len(got) != 1 {
		t.Errorf("got %+v, want Mixed kept", got)
	}
}

func TestInstalledFontsListsThisMachinesFamilies(t *testing.T) {
	fonts, err := Current().InstalledFonts()
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Font{}
	names := []string{}
	for _, font := range fonts {
		if strings.HasPrefix(font.Name, "@") || font.Name == "" {
			t.Errorf("unusable name %q in the list", font.Name)
		}
		if _, dup := byName[font.Name]; dup {
			t.Errorf("%q listed twice", font.Name)
		}
		byName[font.Name] = font
		names = append(names, font.Name)
	}
	if !sort.StringsAreSorted(names) {
		t.Error("not sorted")
	}
	// Arial and Courier New ship with every Windows since 3.1; Fixedsys is a
	// raster font and Wingdings a symbol font on all of them.
	if f, ok := byName["Arial"]; !ok || f.Monospaced {
		t.Errorf("Arial = %+v, %v; want listed, proportional", f, ok)
	}
	if f, ok := byName["Courier New"]; !ok || !f.Monospaced {
		t.Errorf("Courier New = %+v, %v; want listed, monospaced", f, ok)
	}
	for _, gone := range []string{"Fixedsys", "Wingdings", "Segoe MDL2 Assets"} {
		if _, ok := byName[gone]; ok {
			t.Errorf("%s listed; it draws no text", gone)
		}
	}
}
