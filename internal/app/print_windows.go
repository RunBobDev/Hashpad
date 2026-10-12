//go:build windows

package app

// The print view's engine calls (design §4.34): WebView2's PrintToPdf and its
// system print dialog, which Wails does not expose.
//
// Wails keeps the webview in two unexported fields of its frontend; they are
// read by reflection, and print_wails_test.go fails the build if a Wails
// update renames them. The calls are raw COM vtable calls -- not go-webview2's
// pkg/webview2, which panics at start (callbacks NewCallback refuses), leaves
// inherited methods out of its vtables so its PrintToPdf calls the wrong slot,
// and passes doubles by pointer.
//
// PLATFORM: Windows. print_other.go is everything else.

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

// Vtable slots, counted through the whole inheritance chain: IUnknown 0-2,
// ICoreWebView2 3-60, then each later interface's methods in declaration
// order. Microsoft never changes a published WebView2 interface -- new methods
// arrive as new interfaces -- so these do not drift with runtime updates.
const (
	slotQueryInterface      = 0
	slotRelease             = 2
	slotGetEnvironment      = 67  // ICoreWebView2_2, its 7th
	slotPrintToPdf          = 80  // ICoreWebView2_7
	slotShowPrintUI         = 114 // ICoreWebView2_16 (Print is 113)
	slotCreatePrintSettings = 14  // ICoreWebView2Environment6
	slotPutPageWidth        = 8   // ICoreWebView2PrintSettings
	slotPutPageHeight       = 10
	slotPutBackgrounds      = 20
	slotPutHeaderAndFooter  = 24
)

// COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM: Windows' dialog, not the engine's.
const printDialogSystem = 1

var (
	iidWebView2_2   = windows.GUID{Data1: 0x9E8F0CF8, Data2: 0xE670, Data3: 0x4B5E, Data4: [8]byte{0xB2, 0xBC, 0x73, 0xE0, 0x61, 0xE3, 0x18, 0x4C}}
	iidWebView2_7   = windows.GUID{Data1: 0x79c24d83, Data2: 0x09a3, Data3: 0x45ae, Data4: [8]byte{0x94, 0x18, 0x48, 0x7f, 0x32, 0xa5, 0x87, 0x40}}
	iidWebView2_16  = windows.GUID{Data1: 0x0EB34DC9, Data2: 0x9F91, Data3: 0x41E1, Data4: [8]byte{0x86, 0x39, 0x95, 0xCD, 0x59, 0x43, 0x90, 0x6B}}
	iidEnvironment6 = windows.GUID{Data1: 0xe59ee362, Data2: 0xacbd, Data3: 0x4857, Data4: [8]byte{0x9a, 0x8e, 0xd3, 0x64, 0x4d, 0x94, 0x59, 0xa9}}
)

// vcall calls method `slot` of COM object obj.
//
// uintptrescapes because callers pass `uintptr(unsafe.Pointer(&out))`: the
// directive keeps what those point at on the heap and alive for the call, as
// it does for x/sys/windows' Proc.Call.
//
//go:uintptrescapes
func vcall(obj unsafe.Pointer, slot int, args ...uintptr) uintptr {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, slot*int(unsafe.Sizeof(uintptr(0)))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func release(obj unsafe.Pointer) {
	if obj != nil {
		vcall(obj, slotRelease)
	}
}

// qi returns obj's iid interface, holding a reference the caller releases.
func qi(obj unsafe.Pointer, iid *windows.GUID) (unsafe.Pointer, error) {
	var out unsafe.Pointer
	if hr := vcall(obj, slotQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))); hr != 0 || out == nil {
		return nil, fmt.Errorf("WebView2 lacks interface %v (hresult %#x): runtime too old?", *iid, hr)
	}
	return out, nil
}

// private returns an unexported field of a struct value, made usable.
func private(v reflect.Value, name string) (reflect.Value, error) {
	f := v.FieldByName(name)
	if !f.IsValid() {
		return reflect.Value{}, fmt.Errorf("wails frontend has no field %q", name)
	}
	return reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem(), nil
}

func (a *App) wailsFrontend() (reflect.Value, error) {
	fe := a.ctx.Value("frontend")
	v := reflect.ValueOf(fe)
	if !v.IsValid() || v.Kind() != reflect.Ptr || v.Elem().Kind() != reflect.Struct {
		return reflect.Value{}, fmt.Errorf("unexpected wails frontend %T", fe)
	}
	return v.Elem(), nil
}

var invokeType = reflect.TypeOf((func(func()) bool)(nil))

// onUI runs fn on the window's thread -- WebView2 answers only the thread that
// made it -- and waits for it.
func (a *App) onUI(fn func() error) error {
	fe, err := a.wailsFrontend()
	if err != nil {
		return err
	}
	mw, err := private(fe, "mainWindow")
	if err != nil {
		return err
	}
	invoke := mw.MethodByName("Invoke")
	if !invoke.IsValid() || invoke.Type() != invokeType {
		return errors.New("wails window has no Invoke(func()) bool")
	}
	done := make(chan error, 1)
	queued := invoke.Call([]reflect.Value{reflect.ValueOf(func() { done <- fn() })})
	if !queued[0].Bool() {
		// Invoke could not post to the window, so fn will never run.
		return errors.New("could not reach the window's thread")
	}
	return <-done
}

// coreWebView returns the ICoreWebView2, holding a reference the caller
// releases: go-webview2's GetCoreWebView2 hands back the getter's own.
func (a *App) coreWebView() (unsafe.Pointer, error) {
	fe, err := a.wailsFrontend()
	if err != nil {
		return nil, err
	}
	c, err := private(fe, "chromium")
	if err != nil {
		return nil, err
	}
	chromium, ok := c.Interface().(*edge.Chromium)
	if !ok || chromium == nil {
		return nil, fmt.Errorf("wails chromium is %s", c.Type())
	}
	ctrl := chromium.GetController()
	if ctrl == nil {
		return nil, errors.New("webview not ready")
	}
	core, err := ctrl.GetCoreWebView2()
	if err != nil {
		return nil, err
	}
	return unsafe.Pointer(core), nil
}

// pdfJob is a COM object of Hashpad's own: the completion handler PrintToPdf
// calls. The engine calls it by the address it was given, which is how the
// shared callbacks below find the job that finished.
type pdfJob struct {
	vtbl *[4]uintptr // first: COM reads the vtable at offset 0
	done chan error
}

var (
	pdfJobsMu sync.Mutex
	// pdfJobs also keeps each job reachable while the engine holds its address.
	pdfJobs = map[uintptr]*pdfJob{}

	// Made once: NewCallback has a fixed number of slots per process. Every
	// argument is pointer-sized, which NewCallback requires.
	pdfVtbl = [4]uintptr{
		// QueryInterface
		syscall.NewCallback(func(this, riid uintptr, ppv *uintptr) uintptr {
			*ppv = this
			return 0
		}),
		syscall.NewCallback(func(this uintptr) uintptr { return 1 }), // AddRef
		syscall.NewCallback(func(this uintptr) uintptr { return 1 }), // Release
		// Invoke
		syscall.NewCallback(func(this, errorCode, isSuccessful uintptr) uintptr {
			pdfJobsMu.Lock()
			job := pdfJobs[this]
			delete(pdfJobs, this)
			pdfJobsMu.Unlock()
			if job == nil {
				return 0
			}
			if errorCode != 0 || uint32(isSuccessful) == 0 {
				job.done <- fmt.Errorf("PrintToPdf failed (hresult %#x)", errorCode)
			} else {
				job.done <- nil
			}
			return 0
		}),
	}
)

func enginePrintToPdf(a *App, path string, widthIn, heightIn float64) error {
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	job := &pdfJob{vtbl: &pdfVtbl, done: make(chan error, 1)}
	key := uintptr(unsafe.Pointer(job))
	pdfJobsMu.Lock()
	pdfJobs[key] = job
	pdfJobsMu.Unlock()

	err = a.onUI(func() error {
		core, err := a.coreWebView()
		if err != nil {
			return err
		}
		defer release(core)
		wv2, err := qi(core, &iidWebView2_2)
		if err != nil {
			return err
		}
		defer release(wv2)
		var env unsafe.Pointer
		if hr := vcall(wv2, slotGetEnvironment, uintptr(unsafe.Pointer(&env))); hr != 0 || env == nil {
			return fmt.Errorf("get_Environment: %#x", hr)
		}
		defer release(env)
		env6, err := qi(env, &iidEnvironment6)
		if err != nil {
			return err
		}
		defer release(env6)
		var settings unsafe.Pointer
		if hr := vcall(env6, slotCreatePrintSettings, uintptr(unsafe.Pointer(&settings))); hr != 0 || settings == nil {
			return fmt.Errorf("CreatePrintSettings: %#x", hr)
		}
		defer release(settings)
		// Doubles by value: Go's call stub copies the second argument into
		// XMM1 as well, where the callee reads a double.
		for _, s := range []struct {
			slot int
			arg  uintptr
		}{
			{slotPutPageWidth, uintptr(math.Float64bits(widthIn))},
			{slotPutPageHeight, uintptr(math.Float64bits(heightIn))},
			{slotPutHeaderAndFooter, 0}, // Hashpad's own, in the page CSS
			{slotPutBackgrounds, 1},     // a highlight is only its background
		} {
			if hr := vcall(settings, s.slot, s.arg); hr != 0 {
				return fmt.Errorf("print settings slot %d: %#x", s.slot, hr)
			}
		}
		wv7, err := qi(core, &iidWebView2_7)
		if err != nil {
			return err
		}
		defer release(wv7)
		hr := vcall(wv7, slotPrintToPdf, uintptr(unsafe.Pointer(path16)), uintptr(settings), key)
		runtime.KeepAlive(path16)
		if hr != 0 {
			return fmt.Errorf("PrintToPdf: %#x", hr)
		}
		return nil
	})
	if err != nil {
		pdfJobsMu.Lock()
		delete(pdfJobs, key)
		pdfJobsMu.Unlock()
		return err
	}
	return <-job.done
}

func engineShowPrintUI(a *App) error {
	return a.onUI(func() error {
		core, err := a.coreWebView()
		if err != nil {
			return err
		}
		defer release(core)
		wv16, err := qi(core, &iidWebView2_16)
		if err != nil {
			return err
		}
		defer release(wv16)
		if hr := vcall(wv16, slotShowPrintUI, printDialogSystem); hr != 0 {
			return fmt.Errorf("ShowPrintUI: %#x", hr)
		}
		return nil
	})
}

// engineProbe checks every step the two calls take, without printing.
func engineProbe(a *App) error {
	return a.onUI(func() error {
		core, err := a.coreWebView()
		if err != nil {
			return err
		}
		defer release(core)
		for _, iid := range []*windows.GUID{&iidWebView2_2, &iidWebView2_7, &iidWebView2_16} {
			p, err := qi(core, iid)
			if err != nil {
				return err
			}
			release(p)
		}
		return nil
	})
}
