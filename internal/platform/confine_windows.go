//go:build windows

package platform

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobHandle is deliberately package-level and never closed.
//
// Closing the last handle to a kill-on-close job terminates every process in
// it — including us. Holding it for the lifetime of the process is what makes
// the guarantee work: the handle is released only when the process dies, which
// is exactly the moment we want the children killed.
var jobHandle windows.Handle

// ConfineChildProcesses ties every process this one spawns to its own lifetime.
//
// WebView2 leaks. Closing the window leaves roughly half its process tree
// running — on this project, six processes and around 200 MB, accumulating with
// every launch. It is a documented WebView2 defect rather than anything the
// host controls (WebView2Feedback #1424), so there is no API to call and no
// Wails option to set; the fix has to come from outside the webview.
//
// A job object is the Windows mechanism for exactly this. Child processes
// inherit job membership automatically, so putting ourselves in one with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE means Windows tears the whole tree down
// when we exit — on a clean quit, on a crash, and on a force-kill alike, which
// is more than any shutdown handler could promise.
//
// PLATFORM: Windows-only. Linux does not need it — WebKitGTK's helpers are in
// our process group and die with it — so platform_linux.go is a no-op rather
// than a stub returning ErrNotImplemented.
func ConfineChildProcesses() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("create job object: %w", err)
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("set job limits: %w", err)
	}

	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("assign process to job: %w", err)
	}

	jobHandle = job
	return nil
}
