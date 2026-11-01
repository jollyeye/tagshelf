//go:build windows

package main

import (
	"os"
	"sort"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32       = syscall.NewLazyDLL("kernel32.dll")
	procVolumeInfo = kernel32.NewProc("GetVolumeInformationW")
	procDriveTypeW = kernel32.NewProc("GetDriveTypeW")
	procErrorMode  = kernel32.NewProc("SetErrorMode")
)

func init() {
	// Probing an empty card reader or floppy drive must not pop up a "no disk in drive" dialog.
	const semFailCriticalErrors = 0x0001
	procErrorMode.Call(semFailCriticalErrors)
}

func volumeLabel(root string) string {
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return ""
	}
	buf := make([]uint16, 261)
	r, _, _ := procVolumeInfo.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&buf[0])), 261, 0, 0, 0, 0, 0)
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

func driveKind(root string) string {
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return "fixed"
	}
	t, _, _ := procDriveTypeW.Call(uintptr(unsafe.Pointer(p)))
	switch t {
	case 2:
		return "removable"
	case 4:
		return "network"
	case 5:
		return "cdrom"
	}
	return "fixed"
}

func listDrives() []Drive {
	type res struct {
		d  Drive
		ok bool
	}
	ch := make(chan res, 26)
	for c := 'A'; c <= 'Z'; c++ {
		go func(c rune) {
			root := string(c) + `:\`
			if _, err := os.Stat(root); err != nil {
				ch <- res{}
				return
			}
			name := string(c) + ":"
			if l := volumeLabel(root); l != "" {
				name = l + " (" + string(c) + ":)"
			} else {
				name = "Local Disk (" + string(c) + ":)"
			}
			ch <- res{Drive{Name: name, Path: root, Kind: driveKind(root)}, true}
		}(c)
	}
	var out []Drive
	deadline := time.After(1500 * time.Millisecond)
	for i := 0; i < 26; i++ {
		select {
		case r := <-ch:
			if r.ok {
				out = append(out, r.d)
			}
		case <-deadline:
			i = 26
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}
