package app

import (
	"net/http"
	"path/filepath"
	"strings"
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

// AssetHandler serves images from the directory named in the request.
//
// **The directory travels in the URL, not in server state.** It used to live in
// a mutex-guarded field the frontend set over IPC before each render, which was
// a race: on a tab switch the new <img> is in the DOM the moment the IPC call
// is *dispatched*, so the GET could resolve against the outgoing document's
// folder -- two documents in different folders both naming `pic.png` showed
// each other's image, and a name only the new folder had 404'd. Because the URL
// was byte-identical either way, the webview cache could then hold the wrong
// result for the rest of the session. Putting the directory in the query fixes
// the cache problem as a side effect: different folders now mean different
// URLs. It is no weaker security-wise -- the frontend was always the source of
// this string, and every check below still runs on it.
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
// A package-level function, not a method on *App -- and it must stay one even
// though it no longer needs the *App at all. Wails binds every exported method
// of any struct passed to options.App.Bind, with no per-method opt-out --
// confirmed against wails v2.13.0's internal/binding: the only exemption list
// (app_bindings.go's bindingExemptions) is hardcoded to the lifecycle methods
// Wails itself calls, not something App options can extend. A method here
// would be auto-bound and exposed on window.go.app.App despite returning
// something no frontend call can use; `wails generate module` confirmed the
// failure mode on the first attempt -- it emitted `Promise<http.Handler>` in
// App.d.ts, importing a `http` namespace that does not exist in models.ts,
// which fails `tsc --noEmit`.
func AssetHandler() http.Handler {
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

		// images.ts renders a placeholder rather than a URL when the document
		// has no directory, so an empty `dir` should never arrive -- but this
		// is the trust boundary, so it refuses rather than assumes.
		//
		// No test distinguishes *this line*: measured by deleting it, and
		// TestAssetHandlerWithNoActiveDocument stays green, because
		// filepath.IsAbs("") is false and the guard below returns the same 403
		// one step later. The behaviour is covered; the line is not. It is kept
		// because "no directory" and "a directory that is not absolute" are
		// different refusals and reading them as one costs the next person a
		// detour through IsAbs's empty-string case.
		dir := r.URL.Query().Get("dir")
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

		// The path must be anchored at `dir` and nowhere else. `filepath.IsAbs`
		// is not enough on Windows -- `C:foo` is drive-relative and reports
		// false -- so this used to be a hand-rolled
		// `VolumeName(rel) != "" || HasPrefix(rel, "/")`.
		//
		// `filepath.IsLocal` (Go 1.20+) is that pair in one stdlib call, and is
		// the same primitive `images.go` uses for the asset folder -- so the two
		// path boundaries in this package now agree rather than each carrying
		// its own idea of containment.
		//
		// **It adds no protection, and that was measured rather than assumed.**
		// Reverting this line to the hand-rolled pair leaves the whole suite
		// green, because every input `IsLocal` rejects is already refused
		// downstream: absolute and drive-relative paths by the pair it replaced,
		// `../x.png` by the `..` check below, and a bare `NUL`/`CON`/`COM1` by
		// the **extension allow-list** -- a device name has no image extension.
		// This is a consistency change. Claiming otherwise would be the third
		// wrong thing said about it (see below).
		//
		// What it does change is *which* layer refuses a bare device name:
		// intent rather than the allow-list's side effect. That only matters the
		// day someone widens the allow-list, which is exactly when nobody will
		// be thinking about `NUL`.
		//
		// **Two corrections, both from measurement.** This was first written up
		// as a security hole in `assets.go`; it is not, and never was. The note
		// that then scheduled it claimed `IsLocal` rejects "Windows device names
		// (NUL)", full stop -- on go1.26.5 it rejects the *bare* name and
		// **accepts `NUL.png`**. So the file header's "every check below is
		// lexical and runs before any filesystem access" has one exception:
		// `NUL.png` passes every check here and is refused by `os.Open` inside
		// `http.ServeFile`, which is the runtime's behaviour rather than this
		// handler's intention.
		//
		// That exception is accepted rather than closed. Closing it means a
		// hand-rolled reserved-name matcher, which has to get `COM0`, trailing
		// dots and trailing spaces right to be worth anything, and getting it
		// wrong is a likelier defect than the one it prevents. The residual is
		// "a future Go stops refusing device names, and `COM1.png` blocks on a
		// serial port" -- covered by `TestAssetHandlerRefusesDeviceNames`, which
		// fails loudly if that day comes, and by
		// `TestFilepathIsLocalOnDeviceNames`, which pins the premise this
		// comment rests on so it cannot rot into a fourth wrong claim.
		if !filepath.IsLocal(rel) {
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
		// DOMPurify keeps by design, so a hand-written
		// `[x](/__hashpad/asset?dir=...&path=evil.svg)` in an untrusted
		// document would be a top-level navigation to
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
