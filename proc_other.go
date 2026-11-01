//go:build !windows

package main

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}

func claimForeground()      {}
func shellOpen(string) bool { return false }

func explorerSelect(string) error { return nil }
func explorerOpen(string) error   { return nil }
