package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Folder previews: up to four pictures/videos from inside a folder (automatic), or one picture the user chose.

// Cover is a preview chosen by the user for one folder. Image "-" means "no preview, show the folder icon".
type Cover struct {
	Folder string `json:"folder"`
	Image  string `json:"image"`
}

type CoverItem struct {
	Path  string `json:"p"`
	Kind  string `json:"k"`
	Ext   string `json:"x"`
	MTime int64  `json:"m"`
}

type CoverInfo struct {
	Items  []CoverItem `json:"items"`
	Count  int         `json:"n"` // number of entries in the folder, -1 when it is too big to count cheaply
	Custom bool        `json:"custom,omitempty"`
	None   bool        `json:"none,omitempty"`
}

type coverCacheEntry struct {
	mtime int64
	info  CoverInfo
}

var (
	coverMu    sync.Mutex
	coverCache = map[string]coverCacheEntry{}
)

const coverScanLimit = 2000

func scanCover(dir string) CoverInfo {
	info := CoverInfo{Items: []CoverItem{}}
	f, err := os.Open(dir)
	if err != nil {
		info.Count = -1
		return info
	}
	defer f.Close()
	des, _ := f.ReadDir(coverScanLimit)
	info.Count = 0
	for _, d := range des {
		if !strings.HasPrefix(d.Name(), ".") {
			info.Count++
		}
	}
	if len(des) >= coverScanLimit {
		info.Count = -1
	}
	sort.Slice(des, func(i, j int) bool { return collateName(des[i].Name()) < collateName(des[j].Name()) })
	for _, d := range des {
		if len(info.Items) >= 4 {
			break
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			continue
		}
		ext := lowerExt(d.Name())
		k := kindOf(ext)
		if k != "image" && k != "video" {
			continue
		}
		st, err := d.Info()
		if err != nil || isHiddenInfo(st, d.Name()) {
			continue
		}
		info.Items = append(info.Items, CoverItem{Path: filepath.Join(dir, d.Name()), Kind: k, Ext: ext, MTime: st.ModTime().Unix()})
	}
	return info
}

func collateName(s string) string { return toLower(s) }

func (l *Library) CoverFor(folder string) (string, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	c := l.Covers[fileID(folder)]
	if c == nil {
		return "", false
	}
	return c.Image, true
}

func (l *Library) SetCover(folder, image string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if image == "" {
		if _, ok := l.Covers[fileID(folder)]; ok {
			delete(l.Covers, fileID(folder))
			l.touch()
		}
		return
	}
	if l.Covers == nil {
		l.Covers = map[string]*Cover{}
	}
	l.Covers[fileID(folder)] = &Cover{Folder: folder, Image: image}
	l.touch()
}

// relocateCovers follows folders and chosen pictures that were moved or renamed inside TagShelf.
// Called with l.mu held.
func (l *Library) relocateCovers(pairs []Pair) {
	if len(l.Covers) == 0 {
		return
	}
	mapPath := func(p string) (string, bool) {
		for _, pr := range pairs {
			switch {
			case samePath(p, pr.From):
				return pr.To, true
			case underRoot(p, pr.From):
				return pr.To + p[len(strings.TrimRight(pr.From, string(filepath.Separator))):], true
			}
		}
		return p, false
	}
	next := map[string]*Cover{}
	changed := false
	for id, c := range l.Covers {
		nf, a := mapPath(c.Folder)
		ni := c.Image
		b := false
		if c.Image != "-" {
			ni, b = mapPath(c.Image)
		}
		if a || b {
			changed = true
			c = &Cover{Folder: nf, Image: ni}
			id = fileID(nf)
		}
		next[id] = c
	}
	if changed {
		l.Covers = next
		l.touch()
	}
}

func (s *Server) apiCovers(r *http.Request, in struct{ Folders []string }) (any, error) {
	if len(in.Folders) > 120 {
		in.Folders = in.Folders[:120]
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	out := make(map[string]CoverInfo, len(in.Folders))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, raw := range in.Folders {
		p, err := cleanAbs(raw)
		if err != nil {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(raw, p string) {
			defer wg.Done()
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}
			st, err := os.Stat(p)
			if err != nil || !st.IsDir() {
				return
			}
			var info CoverInfo
			if img, ok := s.lib.CoverFor(p); ok {
				switch {
				case img == "-":
					info = CoverInfo{Items: []CoverItem{}, None: true, Count: -1}
				default:
					if is, err := os.Stat(img); err == nil && !is.IsDir() {
						ext := lowerExt(img)
						info = CoverInfo{Items: []CoverItem{{Path: img, Kind: kindOf(ext), Ext: ext, MTime: is.ModTime().Unix()}}, Custom: true, Count: -1}
					} else {
						ok = false // the chosen picture is gone: fall back to automatic
					}
				}
				if len(info.Items) > 0 || info.None {
					mu.Lock()
					out[raw] = info
					mu.Unlock()
					return
				}
			}
			key := p
			mt := st.ModTime().UnixNano()
			coverMu.Lock()
			ce, hit := coverCache[key]
			coverMu.Unlock()
			if hit && ce.mtime == mt {
				info = ce.info
			} else {
				info = scanCover(p)
				coverMu.Lock()
				if len(coverCache) > 5000 {
					coverCache = map[string]coverCacheEntry{}
				}
				coverCache[key] = coverCacheEntry{mt, info}
				coverMu.Unlock()
			}
			mu.Lock()
			out[raw] = info
			mu.Unlock()
		}(raw, p)
	}
	wg.Wait()
	return map[string]any{"covers": out}, nil
}

func (s *Server) apiSetCover(r *http.Request, in struct {
	Folder string
	Image  string
}) (any, error) {
	folder, err := cleanAbs(in.Folder)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(folder); err != nil || !st.IsDir() {
		return nil, errors.New("that folder doesn't exist")
	}
	img := in.Image
	if img != "" && img != "-" {
		if img, err = cleanAbs(img); err != nil {
			return nil, err
		}
		if st, err := os.Stat(img); err != nil || st.IsDir() {
			return nil, errors.New("that picture doesn't exist")
		}
		if k := kindOf(lowerExt(img)); k != "image" && k != "video" {
			return nil, errors.New("choose a picture or a video")
		}
	}
	s.lib.SetCover(folder, img)
	return ok, nil
}

// handlePoster stores a still frame of a video (made by the browser) so that video previews are instant next time.
func (s *Server) handlePoster(w http.ResponseWriter, r *http.Request) {
	p, st, err := queryFile(r)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f := recFromInfo(p, st)
	if f.Kind != "video" {
		http.Error(w, "not a video", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil || len(body) < 4 || body[0] != 0xFF || body[1] != 0xD8 {
		http.Error(w, "expected a JPEG", http.StatusBadRequest)
		return
	}
	dst := thumbPath(s.dataDir, f)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
