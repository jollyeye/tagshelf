//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Outside Windows there are no change notifications or download marks. This stand-in exists so the
// same code path can be tested: set TAGSHELF_WATCH_ROOT to a folder and new files in it (any depth)
// are reported; a "<file>:Zone.Identifier" text file next to a picture plays the part of the web mark.
func startDriveWatch(w *Watcher) {
	root := os.Getenv("TAGSHELF_WATCH_ROOT")
	if root == "" {
		return
	}
	known := map[string]bool{}
	first := true
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || strings.HasSuffix(p, ":Zone.Identifier") {
				return nil
			}
			if !known[p] {
				known[p] = true
				if !first {
					w.noteFile(p)
				}
			}
			return nil
		})
		first = false
		select {
		case <-w.s.quit:
			return
		case <-t.C:
		}
	}
}

func hasWebMark(path string) bool {
	b, err := os.ReadFile(path + ":Zone.Identifier")
	return err == nil && strings.Contains(string(b), "ZoneId=3")
}

func createdAt(fi os.FileInfo) time.Time { return fi.ModTime() }
