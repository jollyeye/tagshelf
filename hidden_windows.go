//go:build windows

package main

import (
	"io/fs"
	"syscall"
)

func isHiddenInfo(info fs.FileInfo, name string) bool {
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return d.FileAttributes&(syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM) != 0
	}
	return false
}
