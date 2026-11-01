//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

// hideWindow stops helper processes (PowerShell, rundll32) from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	procKeybdEvent         = user32.NewProc("keybd_event")
	procAllowSetForeground = user32.NewProc("AllowSetForegroundWindow")
	procShellExecuteW      = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
)

// claimForeground lets the program we are about to start come to the front. Windows only allows that for
// a process that recently received keyboard input; a tap on the Alt key counts, and then we pass the right on.
func claimForeground() {
	const vkMenu, keyUp = 0x12, 0x2
	procKeybdEvent.Call(vkMenu, 0, 0, 0)
	procKeybdEvent.Call(vkMenu, 0, keyUp, 0)
	procAllowSetForeground.Call(^uintptr(0)) // ASFW_ANY
}

// shellOpen opens a file with its default program, like a double-click in Explorer, and brings it to the front.
func shellOpen(path string) bool {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	const swShowNormal = 1
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, swShowNormal)
	return r > 32
}
