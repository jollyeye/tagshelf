package main

// A deliberately small "AI": every image/video gets a 152-number fingerprint (colour layout,
// colour histogram, edge directions, a few global measures) computed in the browser.  Tag
// suggestions come from three signals that all learn from the user's own tagging:
//   1. visual neighbours   - the most similar files you already tagged,
//   2. words               - file / folder name words that went with a tag before,
//   3. habits              - tags that are often used together with tags the file already has.
// Nothing is ever applied automatically; the UI only offers the suggestions.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

const vecDim = 152

type vecRec struct {
	Path  string
	MTime int64
	Size  int64
	V     [vecDim]int8
}

type vecIndex struct {
	rev   uint64
	ids   []string
	paths []string
	mat   []float32 // centred, unit length rows
	mean  [vecDim]float32
}

type VecStore struct {
	mu    sync.RWMutex
	path  string
	m     map[string]*vecRec
	rev   uint64
	timer *time.Timer
	idx   *vecIndex
}

var vecs = &VecStore{m: map[string]*vecRec{}}

func (s *VecStore) open(dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.path = filepath.Join(dir, "vectors.bin")
	b, err := os.ReadFile(s.path)
	if err != nil || len(b) < 10 || string(b[:4]) != "TSV2" {
		return
	}
	if int(binary.LittleEndian.Uint16(b[4:6])) != vecDim {
		return // fingerprint format changed; they will be recomputed
	}
	n := int(binary.LittleEndian.Uint32(b[6:10]))
	off := 10
	for i := 0; i < n; i++ {
		if off+8 > len(b) {
			break
		}
		off += 6 // id (recomputed from the path)
		pl := int(binary.LittleEndian.Uint16(b[off:]))
		off += 2
		if off+pl+16+vecDim > len(b) {
			break
		}
		r := &vecRec{Path: string(b[off : off+pl])}
		off += pl
		r.MTime = int64(binary.LittleEndian.Uint64(b[off:]))
		r.Size = int64(binary.LittleEndian.Uint64(b[off+8:]))
		off += 16
		for j := 0; j < vecDim; j++ {
			r.V[j] = int8(b[off+j])
		}
		off += vecDim
		s.m[fileID(r.Path)] = r
	}
}

func (s *VecStore) save() error {
	s.mu.RLock()
	buf := make([]byte, 10, 10+len(s.m)*(8+100+16+vecDim))
	copy(buf, "TSV2")
	binary.LittleEndian.PutUint16(buf[4:], vecDim)
	binary.LittleEndian.PutUint32(buf[6:], uint32(len(s.m)))
	for id, r := range s.m {
		var idb [6]byte
		for i := 0; i < 6 && i*2+1 < len(id); i++ {
			var x byte
			fmt.Sscanf(id[i*2:i*2+2], "%02x", &x)
			idb[i] = x
		}
		buf = append(buf, idb[:]...)
		buf = binary.LittleEndian.AppendUint16(buf, uint16(len(r.Path)))
		buf = append(buf, r.Path...)
		buf = binary.LittleEndian.AppendUint64(buf, uint64(r.MTime))
		buf = binary.LittleEndian.AppendUint64(buf, uint64(r.Size))
		for _, x := range r.V {
			buf = append(buf, byte(x))
		}
	}
	p := s.path
	s.mu.RUnlock()
	if p == "" {
		return nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// dirty schedules a save; the caller holds the write lock.
func (s *VecStore) dirty() {
	s.rev++
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(4*time.Second, func() {
		s.mu.Lock()
		s.timer = nil
		s.mu.Unlock()
		_ = s.save()
	})
}

func (s *VecStore) Get(id string, mtime, size int64) *vecRec {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if r, ok := s.m[id]; ok && r.MTime == mtime && r.Size == size {
		return r
	}
	return nil
}

func (s *VecStore) Put(path string, mtime, size int64, v []float64) error {
	if len(v) != vecDim {
		return errors.New("wrong fingerprint size")
	}
	r := &vecRec{Path: path, MTime: mtime, Size: size}
	for i, x := range v {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return errors.New("bad fingerprint")
		}
		x = math.Max(-1, math.Min(1, x))
		r.V[i] = int8(math.Round(x * 127))
	}
	s.mu.Lock()
	s.m[fileID(path)] = r
	s.dirty()
	s.mu.Unlock()
	return nil
}

func (s *VecStore) Rekey(idMap, pathMap map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for old, nw := range idMap {
		if r, ok := s.m[old]; ok {
			delete(s.m, old)
			if p, ok := pathMap[nw]; ok {
				r.Path = p
			}
			s.m[nw] = r
		}
	}
	s.dirty()
}

func (s *VecStore) RelocatePaths(pairs []Pair) {
	s.mu.Lock()
	defer s.mu.Unlock()
	type mv struct {
		old string
		r   *vecRec
	}
	var moves []mv
	for id, r := range s.m {
		for _, p := range pairs {
			var np string
			switch {
			case samePath(r.Path, p.From):
				np = p.To
			case underRoot(r.Path, p.From):
				np = p.To + r.Path[len(strings.TrimRight(p.From, string(filepath.Separator))):]
			default:
				continue
			}
			r.Path = np
			moves = append(moves, mv{id, r})
			break
		}
	}
	for _, m := range moves {
		delete(s.m, m.old)
	}
	for _, m := range moves {
		s.m[fileID(m.r.Path)] = m.r
	}
	if len(moves) > 0 {
		s.dirty()
	}
}

func (s *VecStore) Copy(from, to string) {
	st, err := os.Stat(to)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.m[fileID(from)]; ok {
		c := *r
		c.Path, c.MTime, c.Size = to, st.ModTime().Unix(), st.Size()
		s.m[fileID(to)] = &c
		s.dirty()
	}
}

func (s *VecStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.m)
}

// index builds (and caches) a matrix of mean-centred unit vectors for fast similarity search.
func (s *VecStore) index() *vecIndex {
	s.mu.RLock()
	if s.idx != nil && s.idx.rev == s.rev {
		ix := s.idx
		s.mu.RUnlock()
		return ix
	}
	n := len(s.m)
	ix := &vecIndex{rev: s.rev, ids: make([]string, 0, n), paths: make([]string, 0, n), mat: make([]float32, n*vecDim)}
	var sum [vecDim]float64
	for id, r := range s.m {
		row := len(ix.ids)
		ix.ids = append(ix.ids, id)
		ix.paths = append(ix.paths, r.Path)
		for j, x := range r.V {
			f := float32(x) / 127
			ix.mat[row*vecDim+j] = f
			sum[j] += float64(f)
		}
	}
	s.mu.RUnlock()
	if n > 0 {
		for j := range ix.mean {
			ix.mean[j] = float32(sum[j] / float64(n))
		}
	}
	for row := 0; row < n; row++ {
		r := ix.mat[row*vecDim : (row+1)*vecDim]
		var nn float64
		for j := range r {
			r[j] -= ix.mean[j]
			nn += float64(r[j] * r[j])
		}
		if nn > 1e-12 {
			inv := float32(1 / math.Sqrt(nn))
			for j := range r {
				r[j] *= inv
			}
		}
	}
	s.mu.Lock()
	if ix.rev == s.rev {
		s.idx = ix
	}
	s.mu.Unlock()
	return ix
}

func (ix *vecIndex) centred(v *[vecDim]int8) (q [vecDim]float32) {
	var nn float64
	for j := range q {
		q[j] = float32(v[j])/127 - ix.mean[j]
		nn += float64(q[j] * q[j])
	}
	if nn > 1e-12 {
		inv := float32(1 / math.Sqrt(nn))
		for j := range q {
			q[j] *= inv
		}
	}
	return
}

type neighbour struct {
	row int
	sim float32
}

// nearest returns the k most similar rows accepted by ok.
func (ix *vecIndex) nearest(q *[vecDim]float32, k int, ok func(row int) bool) []neighbour {
	top := make([]neighbour, 0, k+1)
	for row := 0; row < len(ix.ids); row++ {
		if !ok(row) {
			continue
		}
		m := ix.mat[row*vecDim : (row+1)*vecDim]
		var d float32
		for j := 0; j < vecDim; j++ {
			d += m[j] * q[j]
		}
		if len(top) == k && d <= top[k-1].sim {
			continue
		}
		pos := sort.Search(len(top), func(i int) bool { return top[i].sim < d })
		top = append(top, neighbour{})
		copy(top[pos+1:], top[pos:])
		top[pos] = neighbour{row, d}
		if len(top) > k {
			top = top[:k]
		}
	}
	return top
}

// ---------- name words ----------

var stopWords = map[string]bool{
	"img": true, "image": true, "images": true, "photo": true, "photos": true, "pic": true, "pics": true, "dsc": true,
	"jpg": true, "jpeg": true, "png": true, "gif": true, "webp": true, "copy": true, "new": true, "final": true,
	"the": true, "and": true, "for": true, "with": true, "untitled": true, "download": true, "downloads": true,
	"file": true, "files": true, "video": true, "videos": true, "vid": true, "mov": true, "mp4": true,
	"desktop": true, "pictures": true, "documents": true, "users": true, "temp": true, "tmp": true, "screenshots": false,
}

func words(s string) []string {
	var out []string
	seen := map[string]bool{}
	var cur []rune
	var prev rune
	flush := func() {
		if len(cur) >= 3 {
			w := strings.ToLower(string(cur))
			allDigits := true
			for _, r := range w {
				if !unicode.IsDigit(r) {
					allDigits = false
					break
				}
			}
			if !allDigits && !stopWords[w] && !seen[w] {
				seen[w] = true
				out = append(out, w)
			}
		}
		cur = cur[:0]
	}
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			flush()
			prev = r
			continue
		}
		if unicode.IsUpper(r) && unicode.IsLower(prev) {
			flush()
		}
		cur = append(cur, r)
		prev = r
	}
	flush()
	return out
}

func nameWords(path string) (name, dir []string) {
	base := filepath.Base(path)
	base = strings.TrimSuffix(base, filepath.Ext(base))
	return words(base), words(filepath.Base(filepath.Dir(path)))
}

// ---------- learning tables ----------

type tables struct {
	rev      uint64
	tokCount map[string]int
	tokTag   map[string]map[string]int
	tagCount map[string]int
	co       map[string]map[string]int
	tagged   int
}

type AI struct {
	lib *Library
	mu  sync.Mutex
	tb  *tables
}

func (a *AI) tables() *tables {
	a.lib.mu.RLock()
	defer a.lib.mu.RUnlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.tb != nil && a.tb.rev == a.lib.rev {
		return a.tb
	}
	t := &tables{rev: a.lib.rev, tokCount: map[string]int{}, tokTag: map[string]map[string]int{},
		tagCount: map[string]int{}, co: map[string]map[string]int{}}
	for _, f := range a.lib.Files {
		if len(f.Tags) == 0 || f.IsDir {
			continue
		}
		t.tagged++
		n, d := nameWords(f.Path)
		union := map[string]bool{}
		for _, w := range n {
			union[w] = true
		}
		for _, w := range d {
			union[w] = true
		}
		for w := range union {
			t.tokCount[w]++
			m := t.tokTag[w]
			if m == nil {
				m = map[string]int{}
				t.tokTag[w] = m
			}
			for _, tg := range f.Tags {
				m[tg]++
			}
		}
		for _, u := range f.Tags {
			t.tagCount[u]++
			m := t.co[u]
			if m == nil {
				m = map[string]int{}
				t.co[u] = m
			}
			for _, v := range f.Tags {
				if v != u {
					m[v]++
				}
			}
		}
	}
	a.tb = t
	return t
}

type Sug struct {
	Tag   string   `json:"tag"`
	Score float64  `json:"score"`
	Why   []string `json:"why"`
}

type SugOut struct {
	Ready   bool     `json:"ready"`
	Trained int      `json:"trained"`
	Need    []string `json:"need,omitempty"`
	Items   []Sug    `json:"items"`
}

const minTrained = 6

type acc struct {
	vis, tok, co float64
	why          []string
}

func (a *AI) scoreOne(path string, ix *vecIndex, tb *tables, loo bool, skip map[string]bool, st os.FileInfo) (map[string]*acc, bool) {
	res := map[string]*acc{}
	get := func(t string) *acc {
		x := res[t]
		if x == nil {
			x = &acc{}
			res[t] = x
		}
		return x
	}
	id := fileID(path)
	a.lib.mu.RLock()
	own := a.lib.Files[id]
	var ownTags []string
	if own != nil {
		ownTags = own.Tags
	}
	tagNames := make([]string, 0, len(a.lib.Tags))
	for n := range a.lib.Tags {
		tagNames = append(tagNames, n)
	}
	a.lib.mu.RUnlock()

	// 1. visual neighbours
	needVec := false
	if kind := kindOf(strings.ToLower(filepath.Ext(path))); kind == "image" || kind == "video" {
		if r := vecs.Get(id, st.ModTime().Unix(), st.Size()); r == nil {
			needVec = true
		} else if len(ix.ids) > 0 {
			q := ix.centred(&r.V)
			a.lib.mu.RLock()
			nb := ix.nearest(&q, 10, func(row int) bool {
				rid := ix.ids[row]
				if rid == id || skip[rid] {
					return false
				}
				f := a.lib.Files[rid]
				return f != nil && len(f.Tags) > 0
			})
			type hit struct {
				tags []string
				w    float64
			}
			var hits []hit
			var wsum float64
			var best float32 = -1
			for _, n := range nb {
				f := a.lib.Files[ix.ids[n.row]]
				if f == nil {
					continue
				}
				w := math.Exp(8 * float64(n.sim))
				hits = append(hits, hit{f.Tags, w})
				wsum += w
				if n.sim > best {
					best = n.sim
				}
			}
			a.lib.mu.RUnlock()
			if wsum > 0 {
				conf := math.Max(0, math.Min(1, (float64(best)-0.25)/0.45))
				per, cnt := map[string]float64{}, map[string]int{}
				for _, h := range hits {
					for _, t := range h.tags {
						per[t] += h.w
						cnt[t]++
					}
				}
				for t, w := range per {
					s := w / wsum * conf
					if s >= 0.05 {
						x := get(t)
						x.vis = s
						x.why = append(x.why, fmt.Sprintf("looks like %d of your “%s” files", cnt[t], t))
					}
				}
			}
		}
	}

	// 2. words in the file / folder name
	nw, dw := nameWords(path)
	type wt struct {
		w string
		k float64
	}
	var ws []wt
	for _, w := range nw {
		ws = append(ws, wt{w, 1})
	}
	for _, w := range dw {
		ws = append(ws, wt{w, 0.7})
	}
	ownWords := map[string]bool{}
	if loo && own != nil {
		for _, w := range nw {
			ownWords[w] = true
		}
		for _, w := range dw {
			ownWords[w] = true
		}
	}
	for _, e := range ws {
		ct := tb.tokCount[e.w]
		if ownWords[e.w] {
			ct--
		}
		if ct >= 2 {
			for t, c := range tb.tokTag[e.w] {
				if ownWords[e.w] && hasTag(ownTags, t) {
					c--
				}
				if c <= 0 {
					continue
				}
				p := float64(c) / (float64(ct) + 1) * e.k
				if p >= 0.2 {
					x := get(t)
					if p > x.tok {
						x.tok = p
						x.why = append(x.why, fmt.Sprintf("name has “%s” (went with “%s” before)", e.w, t))
					}
				}
			}
		}
	}
	for _, t := range tagNames {
		tw := words(t)
		if len(tw) == 0 {
			continue
		}
		found := true
		for _, w := range tw {
			okw := false
			for _, e := range ws {
				if e.w == w || e.w == w+"s" || e.w+"s" == w {
					okw = true
					break
				}
			}
			if !okw {
				found = false
				break
			}
		}
		if found {
			x := get(t)
			if x.tok < 0.6 {
				x.tok = 0.6
				x.why = append(x.why, fmt.Sprintf("name contains “%s”", strings.ToLower(t)))
			}
		}
	}

	// 3. habits: tags often used together with the ones this file already has
	if !loo {
		for _, u := range ownTags {
			n := tb.tagCount[u]
			if n < 3 {
				continue
			}
			for t, c := range tb.co[u] {
				p := float64(c) / float64(n)
				if c >= 3 && p >= 0.3 {
					x := get(t)
					if s := 0.6 * p; s > x.co {
						x.co = s
						x.why = append(x.why, fmt.Sprintf("often used together with “%s”", u))
					}
				}
			}
		}
	}
	return res, needVec
}

// Suggest returns tag ideas for one or more files, averaged when several are given.
func (a *AI) Suggest(paths []string, loo bool) SugOut {
	out := SugOut{Items: []Sug{}}
	ix := vecs.index()
	tb := a.tables()
	a.lib.mu.RLock()
	for rid, f := range a.lib.Files {
		if len(f.Tags) > 0 && !f.IsDir && vecs.hasID(rid) {
			out.Trained++
		}
	}
	rejected := map[string][]string{}
	for k, v := range a.lib.Rejected {
		rejected[k] = v
	}
	a.lib.mu.RUnlock()
	out.Ready = out.Trained >= minTrained

	skip := map[string]bool{}
	for _, p := range paths {
		skip[fileID(p)] = true
	}
	total := map[string]*acc{}
	n := 0
	exclude := map[string]int{}
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			continue
		}
		n++
		sc, need := a.scoreOne(p, ix, tb, loo, skip, st)
		if need {
			out.Need = append(out.Need, p)
		}
		id := fileID(p)
		a.lib.mu.RLock()
		if f := a.lib.Files[id]; f != nil && !loo { // when testing, the file's own tags are the answer key
			for _, t := range f.Tags {
				exclude[t]++
			}
		}
		a.lib.mu.RUnlock()
		for _, t := range rejected[id] {
			exclude[t] += len(paths) + 1
		}
		for t, x := range sc {
			s := 1 - (1-x.vis)*(1-x.tok)*(1-x.co)
			tt := total[t]
			if tt == nil {
				tt = &acc{}
				total[t] = tt
			}
			tt.vis += s // reuse vis as the running sum
			if len(tt.why) < 2 {
				tt.why = append(tt.why, x.why...)
			}
		}
	}
	if n == 0 {
		return out
	}
	for t, x := range total {
		if exclude[t] >= n {
			continue
		}
		s := x.vis / float64(n)
		if s < 0.18 {
			continue
		}
		why := x.why
		if len(why) > 2 {
			why = why[:2]
		}
		out.Items = append(out.Items, Sug{Tag: t, Score: math.Round(s*100) / 100, Why: why})
	}
	sort.Slice(out.Items, func(i, j int) bool { return out.Items[i].Score > out.Items[j].Score })
	if len(out.Items) > 10 {
		out.Items = out.Items[:10]
	}
	return out
}

func (s *VecStore) hasID(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.m[id]
	return ok
}

type Similar struct {
	Path string  `json:"path"`
	Sim  float64 `json:"sim"`
}

// FindSimilar lists the files that look most like the given one.
func (a *AI) FindSimilar(path string, n int) ([]Similar, bool) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, false
	}
	r := vecs.Get(fileID(path), st.ModTime().Unix(), st.Size())
	if r == nil {
		return nil, true
	}
	ix := vecs.index()
	q := ix.centred(&r.V)
	self := fileID(path)
	nb := ix.nearest(&q, n+5, func(row int) bool { return ix.ids[row] != self })
	var out []Similar
	for _, x := range nb {
		p := ix.paths[x.row]
		if _, err := os.Stat(p); err != nil {
			continue
		}
		out = append(out, Similar{p, math.Round(float64(x.sim)*1000) / 1000})
		if len(out) >= n {
			break
		}
	}
	return out, false
}

// Backlog lists tagged media files that still need a fingerprint.
func (a *AI) Backlog(limit int) (paths []string, total int) {
	a.lib.mu.RLock()
	defer a.lib.mu.RUnlock()
	for id, f := range a.lib.Files {
		if len(f.Tags) == 0 || f.IsDir || f.Missing || (f.Kind != "image" && f.Kind != "video") {
			continue
		}
		if vecs.Get(id, f.MTime, f.Size) != nil {
			continue
		}
		total++
		if len(paths) < limit {
			paths = append(paths, f.Path)
		}
	}
	return
}

type TestOut struct {
	Tested  int     `json:"tested"`
	Hit     float64 `json:"hit"`
	Recall  float64 `json:"recall"`
	Trained int     `json:"trained"`
}

// Test hides each tagged file's own tags in turn and checks whether the AI would have found them.
func (a *AI) Test(max int) TestOut {
	var cands []string
	a.lib.mu.RLock()
	for id, f := range a.lib.Files {
		if len(f.Tags) > 0 && !f.IsDir && vecs.Get(id, f.MTime, f.Size) != nil {
			cands = append(cands, f.Path)
		}
	}
	a.lib.mu.RUnlock()
	out := TestOut{Trained: len(cands)}
	if len(cands) < minTrained {
		return out
	}
	sort.Slice(cands, func(i, j int) bool { return fileID(cands[i]) < fileID(cands[j]) })
	step := 1
	if len(cands) > max {
		step = len(cands) / max
	}
	var hits, found, truth float64
	for i := 0; i < len(cands) && out.Tested < max; i += step {
		p := cands[i]
		a.lib.mu.RLock()
		f := a.lib.Files[fileID(p)]
		var tags []string
		if f != nil {
			tags = append(tags, f.Tags...)
		}
		a.lib.mu.RUnlock()
		if len(tags) == 0 {
			continue
		}
		res := a.Suggest([]string{p}, true)
		top := res.Items
		if len(top) > 5 {
			top = top[:5]
		}
		got := 0
		for _, s := range top {
			if hasTag(tags, s.Tag) {
				got++
			}
		}
		if got > 0 {
			hits++
		}
		found += float64(got)
		truth += float64(len(tags))
		out.Tested++
	}
	if out.Tested > 0 {
		out.Hit = math.Round(hits/float64(out.Tested)*100) / 100
		out.Recall = math.Round(found/truth*100) / 100
	}
	return out
}

var _ = io.EOF
