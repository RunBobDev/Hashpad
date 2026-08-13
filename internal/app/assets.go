package app

import (
	"net/http"
	"path/filepath"
	"strings"
	"sync"
)

// assetRoute is the path frontend/src/preview/rules/images.ts rewrites relative
// image sources to. Wails' AssetServer forwards any GET the embedded assets
// cannot serve to this handler (assetserver.Options.Handler), which is how a
// request for a file on disk reaches Go without relaxing the CSP: the request
// is same-origin, so `img-src 'self'` already covers it.
const assetRoute = "/__hashpad/asset"

// imageExtensions is a deliberate allow-list. Without it this route is a
// general local-file reader that any opened document could aim at its own
// directory. Images are the only thing the preview needs it for.
var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".bmp": true, ".svg": true, ".avif": true, ".ico": true,
}

// activeDocumentDir is read by the HTTP handler on a Wails-owned goroutine and
// written from the frontend's IPC calls, so it needs the mutex.
type assetState struct {
	mu  sync.RWMutex
	dir string
}

// SetActiveDocumentDir tells the asset handler which directory relative image
// paths resolve against. The frontend calls this whenever the active document
// changes -- on open, on tab switch, and after a save-as moves a document.
// An empty string means the active document has never been saved and therefore
// has no directory; the handler then refuses everything.
func (a *App) SetActiveDocumentDir(dir string) {
	a.assets.mu.Lock()
	defer a.assets.mu.Unlock()
	a.assets.dir = dir
}

func (a *App) activeDocumentDir() string {
	a.assets.mu.RLock()
	defer a.assets.mu.RUnlock()
	return a.assets.dir
}

// AssetHandler serves images from the active document's directory.
//
// This is the one place path traversal is rejected (design §5.7). Every check
// below is lexical and runs before any filesystem access.
//
// A package-level function taking *App, not a method on *App. Wails binds
// every exported method of any struct passed to options.App.Bind, with no
// per-method opt-out -- confirmed against wails v2.13.0's internal/binding:
// the only exemption list (app_bindings.go's bindingExemptions) is hardcoded
// to the lifecycle methods Wails itself calls, not something App options can
// extend. A method here would have been auto-bound and exposed on
// window.go.app.App despite returning something no frontend call can use;
// `wails generate module` confirmed the failure mode on the first attempt --
// it emitted `Promise<http.Handler>` in App.d.ts, importing a `http`
// namespace that does not exist in models.ts, which fails `tsc --noEmit`.
func AssetHandler(a *App) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != assetRoute {
			http.NotFound(w, r)
			return
		}

		rel := r.URL.Query().Get("path")
		if rel == "" {
			http.Error(w, "", http.StatusBadRequest)
			return
		}

		dir := a.activeDocumentDir()
		if dir == "" {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		// Normalise separators first: a document written on Windows may use
		// backslashes, and filepath.Clean on Linux would treat `..\x` as one
		// filename rather than a traversal.
		//
		// No test on this machine distinguishes this line, and that is a
		// property of the platform rather than a gap in coverage: on Windows
		// filepath.Clean already understands a backslash, so the traversal
		// cases below are caught with or without it. It is load-bearing only
		// on Linux, which this project cross-compiles for and does not run
		// tests on. Deleting it here would look free and break the port.
		rel = strings.ReplaceAll(rel, `\`, "/")

		// A volume name means the path is anchored somewhere other than `dir`.
		// filepath.IsAbs is not enough on Windows: `C:foo` is drive-relative
		// and reports false.
		if filepath.VolumeName(rel) != "" || strings.HasPrefix(rel, "/") {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		// A cheap early-out, and deliberately redundant: every input it rejects
		// is also rejected by the containment check below, so no test can tell
		// the two apart -- verified by deleting this block and watching the
		// suite stay green. It stays because this is a security boundary and
		// the two are independent mechanisms: this one is a string comparison,
		// that one trusts filepath.Rel's semantics. If the redundancy ever has
		// to go, delete *this* block, not the check below -- that one is what
		// the tests actually exercise.
		clean := filepath.Clean(rel)
		if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		if !imageExtensions[strings.ToLower(filepath.Ext(clean))] {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		full := filepath.Join(dir, clean)

		// The containment check, and the one that actually does the work:
		// deleting the lexical block above leaves every traversal case still
		// failing here. Named honestly rather than as "belt and braces",
		// because a reader deciding which of the two to simplify away needs to
		// know which one is load-bearing.
		inside, err := filepath.Rel(dir, full)
		if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		http.ServeFile(w, r, full)
	})
}
