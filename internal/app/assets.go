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
// **Symlinks are a deliberate non-goal.** Containment is decided lexically, so
// a symlink *inside* the document's directory pointing outside it resolves and
// is served. The alternative, filepath.EvalSymlinks on every request, costs a
// syscall per image and fails for paths that do not exist yet. The residual
// exposure is "displays a local image the user did not expect" -- there is no
// network to send it anywhere (SPEC §2.1), and the extension allow-list keeps
// it to images. Recorded in docs/testing.md as a manual check rather than left
// implicit.
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

		// The directory must be absolute, and this is not belt-and-braces.
		// `C:` is a *drive-relative* path on Windows -- filepath.Join("C:",
		// "x.png") gives "C:x.png", which the OS resolves against the process
		// working directory, and filepath.Rel("C:", "C:x.png") returns
		// "x.png", so every containment check below passes while the file
		// served comes from somewhere else entirely. Measured: with dir set to
		// "C:", a request returned a file from the repository directory. A
		// document saved at a drive root produces exactly that string.
		if !filepath.IsAbs(dir) {
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
		// cases below are caught with or without it.
		//
		// This is a **compatibility** measure, not a security one -- an
		// earlier version of this comment implied otherwise. On Linux a
		// backslash is an ordinary filename character, so `..\outside.png`
		// there is one filename inside `dir` and simply 404s, which is safe.
		// What the line buys is that a Windows-authored `assets\pic.png`
		// resolves on the Linux build instead of 404ing.
		rel = strings.ReplaceAll(rel, `\`, "/")

		// A volume name means the path is anchored somewhere other than `dir`.
		// filepath.IsAbs is not enough on Windows: `C:foo` is drive-relative
		// and reports false.
		if filepath.VolumeName(rel) != "" || strings.HasPrefix(rel, "/") {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		// This and the containment check below are **mutually** redundant, and
		// no test distinguishes either one: deleting this block leaves the
		// suite green, and so does deleting that one. Measured both ways,
		// twice -- two earlier versions of this comment each nominated one of
		// them as "the one the tests exercise" and both were wrong.
		//
		// They are kept anyway, and the reason is not superstition: this is a
		// security boundary, and the two are independent mechanisms. This one
		// is a string comparison over a cleaned path; that one delegates to
		// filepath.Rel's notion of containment. A bug in either is unlikely to
		// be a bug in both. If the redundancy ever has to go, either may be
		// deleted -- but the guards above must stay, because with them in
		// place `clean` is always relative, volume-free and not `..`-prefixed,
		// which is why neither of these two can be reached with a hostile
		// input in the first place.
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

		// The second of the two redundant containment checks -- see the comment
		// above the lexical one for why both are here and why neither is
		// individually tested.
		inside, err := filepath.Rel(dir, full)
		if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
			http.Error(w, "", http.StatusForbidden)
			return
		}

		// These two headers matter because of one entry in the allow-list.
		// An `.svg` is a document, not just a picture: served at the app's own
		// origin it can carry script, and `index.html`'s CSP is a `<meta>`
		// tag, which does not apply to a document the webview *navigates to*.
		// Once the preview pane lands, a link is a plain `<a href>` that
		// DOMPurify keeps by design, so `[x](/__hashpad/asset?path=evil.svg)`
		// in an untrusted document would be a top-level navigation to
		// attacker-authored content at an origin where Wails' runtime -- and
		// therefore every bound method -- is reachable. Wails' own asset
		// server sets no security headers either (checked v2.13.0: it sets
		// Content-Type and nothing else).
		//
		// `sandbox` with no allow-list denies script, plugins and same-origin
		// alike; `nosniff` stops a mislabelled file being re-interpreted.
		// Neither affects an `<img>`, which is the only thing this route
		// exists to serve.
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		http.ServeFile(w, r, full)
	})
}
