//go:build !windows

package main

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}

func claimForeground()      {}
func shellOpen(string) bool { return false }
