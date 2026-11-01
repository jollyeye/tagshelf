//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// startDriveWatch listens for new files on every fixed or removable drive (Windows change notifications,
// no scanning). New drives that appear later are picked up within 30 seconds.
func startDriveWatch(w *Watcher) {
	var mu sync.Mutex
	active := map[string]bool{}
	for {
		for _, d := range listDrives() {
			if d.Kind != "fixed" && d.Kind != "removable" {
				continue
			}
			mu.Lock()
			if !active[d.Path] {
				active[d.Path] = true
				go func(root string) {
					watchRoot(w, root)
					mu.Lock()
					delete(active, root)
					mu.Unlock()
				}(d.Path)
			}
			mu.Unlock()
		}
		select {
		case <-w.s.quit:
			return
		case <-time.After(30 * time.Second):
		}
	}
}

func watchRoot(w *Watcher, root string) {
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return
	}
	const (
		fileListDirectory = 0x0001
		shareAll          = 0x0007
		backupSemantics   = 0x02000000
		notifyFileName    = 0x0001 // covers files appearing and being renamed into place
		actionAdded       = 1
		actionRenamedNew  = 5
	)
	h, err := syscall.CreateFile(p, fileListDirectory, shareAll, nil, syscall.OPEN_EXISTING, backupSemantics, 0)
	if err != nil {
		return
	}
	defer syscall.CloseHandle(h)
	buf := make([]byte, 64<<10)
	for {
		select {
		case <-w.s.quit:
			return
		default:
		}
		var n uint32
		if err := syscall.ReadDirectoryChanges(h, &buf[0], uint32(len(buf)), true, notifyFileName, &n, nil, 0); err != nil {
			return // drive removed or no longer readable
		}
		if n == 0 {
			continue // too many changes at once; some were missed
		}
		off := uint32(0)
		for off < n {
			fni := (*syscall.FileNotifyInformation)(unsafe.Pointer(&buf[off]))
			if fni.Action == actionAdded || fni.Action == actionRenamedNew {
				name := syscall.UTF16ToString(unsafe.Slice(&fni.FileName, fni.FileNameLength/2))
				w.noteFile(filepath.Join(root, name))
			}
			if fni.NextEntryOffset == 0 {
				break
			}
			off += fni.NextEntryOffset
		}
	}
}

// hasWebMark reports whether Windows recorded that this file came from the internet or another computer
// (the "Mark of the Web" that Edge, Chrome, Firefox and Brave add to every download on NTFS drives).
func hasWebMark(path string) bool {
	b, err := os.ReadFile(path + ":Zone.Identifier")
	if err != nil {
		return false
	}
	s := string(b)
	return strings.Contains(s, "ZoneId=3") || strings.Contains(s, "ZoneId=4")
}

func createdAt(fi os.FileInfo) time.Time {
	if d, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		return time.Unix(0, d.CreationTime.Nanoseconds())
	}
	return fi.ModTime()
}
