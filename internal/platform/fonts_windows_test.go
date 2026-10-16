//go:build windows

package platform

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

// GDI reports a family once per character set, and its vertical twin with a
// leading "@" (for CJK fonts set sideways); the settings dropdown wants each
// usable family once.
func TestFamilyNamesDedupesAndDropsVerticalFonts(t *testing.T) {
	got := familyNames([]string{"Segoe UI", "@MS Gothic", "Arial", "", "Segoe UI", "MS Gothic"})
	want := []string{"Arial", "MS Gothic", "Segoe UI"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("familyNames = %v, want %v", got, want)
	}
}

func TestInstalledFontsListsThisMachinesFamilies(t *testing.T) {
	fonts, err := Current().InstalledFonts()
	if err != nil {
		t.Fatal(err)
	}
	// Arial ships with every Windows since 3.1.
	found := false
	for i, name := range fonts {
		if name == "Arial" {
			found = true
		}
		if strings.HasPrefix(name, "@") || name == "" {
			t.Errorf("unusable name %q in the list", name)
		}
		if i > 0 && fonts[i-1] == name {
			t.Errorf("%q listed twice", name)
		}
	}
	if !found {
		t.Errorf("Arial missing from %d families", len(fonts))
	}
	if !sort.StringsAreSorted(fonts) {
		t.Error("not sorted")
	}
}
