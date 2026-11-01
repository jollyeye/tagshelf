package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Download is a finished image/video download waiting for the user to pick tags.
type Download struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
	At   int64  `json:"at"`
}

type cand struct {
	size   int64
	mtime  int64
	stable int
}

type Watcher struct {
	s         *Server
	mu        sync.Mutex
	seen      map[string]bool
	baselined map[string]bool
	cands     map[string]cand
	ev        map[string]*evCand // files reported by the whole-drive watcher, waiting to settle
	pending   []Download
}

// evCand is a media file the whole-drive watcher saw appear; it is offered once it has stopped growing
// and carries the "downloaded from the internet" mark.
type evCand struct {
	size, mtime int64
	stable      int
	markTries   int
	first       time.Time
}

func newWatcher(s *Server) *Watcher {
	return &Watcher{s: s, seen: map[string]bool{}, baselined: map[string]bool{}, cands: map[string]cand{}, ev: map[string]*evCand{}}
}

func (w *Watcher) Pending() []Download {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]Download, 0, len(w.pending))
	for _, d := range w.pending {
		if exists(d.Path) {
			out = append(out, d)
		}
	}
	return out
}

func (w *Watcher) Find(id string) *Download {
	w.mu.Lock()
	defer w.mu.Unlock()
	for i := range w.pending {
		if w.pending[i].ID == id {
			d := w.pending[i]
			return &d
		}
	}
	return nil
}

func (w *Watcher) Drop(id string, all bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if all {
		w.pending = nil
		return
	}
	for i := range w.pending {
		if w.pending[i].ID == id {
			w.pending = append(w.pending[:i], w.pending[i+1:]...)
			return
		}
	}
}

func (w *Watcher) run() {
	go startDriveWatch(w)
	t := time.NewTicker(1500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-w.s.quit:
			return
		case <-t.C:
			w.scan()
		}
	}
}

func (w *Watcher) dirs() []string {
	w.s.lib.mu.RLock()
	p := w.s.lib.Prefs
	w.s.lib.mu.RUnlock()
	if !p.WatchDownloads {
		return nil
	}
	if len(p.WatchDirs) > 0 {
		return p.WatchDirs
	}
	if !p.NoDriveWatch {
		return nil // the whole drive is watched instead of one default folder
	}
	if d := defaultDownloads(); d != "" {
		return []string{d}
	}
	return nil
}

func (w *Watcher) scan() {
	var fresh []Download
	w.mu.Lock()
	for _, d := range w.dirs() {
		des, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		base := !w.baselined[d]
		for _, e := range des {
			if e.IsDir() {
				continue
			}
			ext := lowerExt(e.Name())
			k := kindOf(ext)
			if (k != "image" && k != "video") || ext == ".svg" {
				continue
			}
			p := filepath.Join(d, e.Name())
			if base {
				w.seen[p] = true
				continue
			}
			if w.seen[p] {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			c := w.cands[p]
			if c.size == info.Size() && c.mtime == info.ModTime().UnixNano() && c.size > 0 {
				c.stable++
			} else {
				c = cand{size: info.Size(), mtime: info.ModTime().UnixNano()}
			}
			if c.stable >= 2 {
				delete(w.cands, p)
				w.seen[p] = true
				fresh = append(fresh, Download{ID: randHex(6), Path: p, Name: e.Name(), Kind: k, Size: info.Size(), At: time.Now().Unix()})
			} else {
				w.cands[p] = c
			}
		}
		w.baselined[d] = true
	}
	fresh = append(fresh, w.settleEvents()...)
	if len(fresh) > 0 {
		sort.Slice(fresh, func(i, j int) bool { return fresh[i].Name < fresh[j].Name })
		w.pending = append(w.pending, fresh...)
	}
	w.mu.Unlock()
	if len(fresh) > 0 {
		log.Printf("%d new download(s) detected", len(fresh))
		w.s.ensurePopup()
	}
}

func lowerExt(name string) string {
	return toLower(filepath.Ext(name))
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// ensurePopup opens the small tag-picker window unless one is already showing.
func (s *Server) ensurePopup() {
	now := time.Now().UnixNano()
	if now-s.popupPing.Load() < int64(6*time.Second) {
		return
	}
	if now-s.popupLast.Load() < int64(10*time.Second) {
		return
	}
	s.popupLast.Store(now)
	url := fmt.Sprintf("http://127.0.0.1:%d/popup.html?t=%s", s.port, s.token)
	if noWindowMode {
		log.Printf("POPUP %s", url)
		return
	}
	openPopup(s.dataDir, url)
}

func (w *Watcher) driveOn() bool {
	w.s.lib.mu.RLock()
	defer w.s.lib.mu.RUnlock()
	return w.s.lib.Prefs.WatchDownloads && !w.s.lib.Prefs.NoDriveWatch
}

// noteFile is called by the whole-drive watcher for every file that appeared or was renamed into place.
// It only does cheap checks; the real decision is made in settleEvents once the file has settled.
func (w *Watcher) noteFile(p string) {
	ext := lowerExt(p)
	if k := kindOf(ext); (k != "image" && k != "video") || ext == ".svg" {
		return
	}
	if excludedPath(p, w.s.dataDir) || !w.driveOn() {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.seen[p] || w.ev[p] != nil || len(w.ev) > 5000 {
		return
	}
	w.ev[p] = &evCand{first: time.Now()}
}

// settleEvents is called with w.mu held. It returns the files that are now ready to be offered.
func (w *Watcher) settleEvents() []Download {
	var out []Download
	for p, c := range w.ev {
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			if time.Since(c.first) > 30*time.Second {
				delete(w.ev, p) // renamed away or removed
			}
			continue
		}
		if c.size == info.Size() && c.mtime == info.ModTime().UnixNano() && c.size > 0 {
			c.stable++
		} else {
			c.size, c.mtime, c.stable = info.Size(), info.ModTime().UnixNano(), 0
		}
		if c.stable < 2 {
			if time.Since(c.first) > 30*time.Minute {
				delete(w.ev, p)
			}
			continue
		}
		if time.Since(createdAt(info)) > 12*time.Hour || w.s.lib.Lookup(p) != nil {
			delete(w.ev, p) // an old file that was only moved around, or one that already has tags
			continue
		}
		if !hasWebMark(p) {
			// the browser may add the mark a moment after the file is in place
			if c.markTries++; c.markTries > 12 {
				delete(w.ev, p)
			}
			continue
		}
		delete(w.ev, p)
		w.seen[p] = true
		k := kindOf(lowerExt(p))
		out = append(out, Download{ID: randHex(6), Path: p, Name: filepath.Base(p), Kind: k, Size: info.Size(), At: time.Now().Unix()})
	}
	return out
}

// excludedPath keeps system folders, app caches and TagShelf's own data out of the whole-drive watch.
func excludedPath(p, dataDir string) bool {
	q := toLower(filepath.ToSlash(p))
	if dataDir != "" && strings.HasPrefix(q, toLower(filepath.ToSlash(dataDir))+"/") {
		return true
	}
	for _, bad := range []string{"/windows/", "/$recycle.bin/", "/system volume information/", "/appdata/", "/program files", "/programdata/"} {
		if strings.Contains(q, bad) {
			return true
		}
	}
	return false
}
