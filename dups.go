package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

type DupFile struct {
	Path   string   `json:"p"`
	MTime  int64    `json:"m"`
	Tags   []string `json:"t,omitempty"`
	Rating int      `json:"r,omitempty"`
}

type DupGroup struct {
	Size  int64     `json:"size"`
	Files []DupFile `json:"files"`
}

// hashFile hashes the first `limit` bytes of a file (the whole file when limit <= 0).
func hashFile(ctx context.Context, path string, limit int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var r io.Reader = f
	if limit > 0 {
		r = io.LimitReader(f, limit)
	}
	h := sha1.New()
	buf := make([]byte, 256<<10)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, err := r.Read(buf)
		h.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// hashAll hashes many files with a few workers; files that can't be read are left out.
func hashAll(ctx context.Context, paths []string, limit int64) map[string]string {
	out := map[string]string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, p := range paths {
		wg.Add(1)
		sem <- struct{}{}
		go func(p string) {
			defer wg.Done()
			defer func() { <-sem }()
			if h, err := hashFile(ctx, p, limit); err == nil {
				mu.Lock()
				out[p] = h
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()
	return out
}

const dupHead = 64 << 10

func (s *Server) apiDups(r *http.Request, in struct {
	Path   string
	Sub    bool
	Hidden bool
}) (any, error) {
	p, err := cleanAbs(in.Path)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	entries, trunc, err := listDir(ctx, p, in.Sub, in.Hidden, 200000)
	if err != nil {
		return nil, err
	}
	bySize := map[int64][]Entry{}
	scanned := 0
	for _, e := range entries {
		if e.IsDir || e.Size == 0 {
			continue
		}
		scanned++
		bySize[e.Size] = append(bySize[e.Size], e)
	}
	var groups []DupGroup
	for size, list := range bySize {
		if len(list) < 2 {
			continue
		}
		paths := make([]string, len(list))
		mt := map[string]int64{}
		for i, e := range list {
			paths[i] = e.Path
			mt[e.Path] = e.MTime
		}
		// first a cheap look at the start of each file, then the whole file for the survivors
		heads := hashAll(ctx, paths, dupHead)
		byHead := map[string][]string{}
		for _, p := range paths {
			if h, ok := heads[p]; ok {
				byHead[h] = append(byHead[h], p)
			}
		}
		for _, cand := range byHead {
			if len(cand) < 2 {
				continue
			}
			sets := map[string][]string{}
			if size <= dupHead {
				sets["same"] = cand
			} else {
				full := hashAll(ctx, cand, 0)
				for _, p := range cand {
					if h, ok := full[p]; ok {
						sets[h] = append(sets[h], p)
					}
				}
			}
			for _, same := range sets {
				if len(same) < 2 {
					continue
				}
				sort.Strings(same)
				g := DupGroup{Size: size}
				for _, p := range same {
					df := DupFile{Path: p, MTime: mt[p]}
					if rec := s.lib.Lookup(p); rec != nil {
						df.Tags, df.Rating = rec.Tags, rec.Rating
					}
					g.Files = append(g.Files, df)
				}
				groups = append(groups, g)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].Size*int64(len(groups[i].Files)-1) > groups[j].Size*int64(len(groups[j].Files)-1)
	})
	if len(groups) > 500 {
		groups = groups[:500]
	}
	if groups == nil {
		groups = []DupGroup{}
	}
	return map[string]any{"groups": groups, "scanned": scanned, "truncated": trunc}, nil
}
