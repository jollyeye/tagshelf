//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow stops helper processes (PowerShell, rundll32) from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
