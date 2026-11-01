package main

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

var mediaExt = map[string]string{
	".jpg": "image", ".jpeg": "image", ".jfif": "image", ".png": "image", ".gif": "image",
	".webp": "image", ".bmp": "image", ".svg": "image", ".avif": "image",
	".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".avi": "video",
	".m4v": "video", ".wmv": "video",
	".mp3": "audio", ".flac": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
	".aac": "audio", ".opus": "audio", ".wma": "audio",
}

var tagPalette = []string{
	"#e5645f", "#e8924a", "#e0b84a", "#7cc36a", "#4bbfa0", "#4cb4d8",
	"#6e9bf0", "#9a82ec", "#c978e0", "#e56fa6", "#9aa5b8", "#b8895f",
}

func kindOf(ext string) string {
	if k, ok := mediaExt[ext]; ok {
		return k
	}
	return "other"
}

// FileRec is what TagShelf remembers about a file or folder that has tags or a rating.
// Untagged files are never stored: the file system itself is the source of truth.
type FileRec struct {
	ID      string   `json:"id"`
	Path    string   `json:"path"`
	Name    string   `json:"name"`
	Dir     string   `json:"dir"`
	Ext     string   `json:"ext"`
	Kind    string   `json:"kind"`
	Size    int64    `json:"size"`
	MTime   int64    `json:"mtime"`
	Added   int64    `json:"added"`
	Tags    []string `json:"tags,omitempty"`
	Rating  int      `json:"rating,omitempty"`
	IsDir   bool     `json:"isdir,omitempty"`
	Missing bool     `json:"-"`
}

type TagInfo struct {
	Color string `json:"color"`
	Used  int64  `json:"used,omitempty"`
}

type View struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	State json.RawMessage `json:"state"`
}

type Prefs struct {
	WatchDownloads bool     `json:"watchDownloads"`
	WatchDirs      []string `json:"watchDirs"`
	Background     bool     `json:"background"`
}

type Library struct {
	mu       sync.RWMutex
	path     string
	timer    *time.Timer
	tagIdx   map[string]string
	rev      uint64
	orphans  map[string][]string
	Version  int                 `json:"version"`
	Roots    []string            `json:"roots,omitempty"` // v1 only; migrated into Pins
	Pins     []string            `json:"pins"`
	Files    map[string]*FileRec `json:"files"`
	Tags     map[string]*TagInfo `json:"tags"`
	Views    []View              `json:"views"`
	Settings json.RawMessage     `json:"settings,omitempty"`
	Prefs    Prefs               `json:"prefs"`
	Recent   []string            `json:"recentDirs,omitempty"`
	Rejected map[string][]string `json:"rejected,omitempty"`
}

// ---------- helpers ----------

func isWin() bool { return runtime.GOOS == "windows" }

func fileID(p string) string {
	if isWin() {
		p = strings.ToLower(p)
	}
	h := sha1.Sum([]byte(p))
	return hex.EncodeToString(h[:6])
}

func samePath(a, b string) bool {
	if isWin() {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func underRoot(p, root string) bool {
	if isWin() {
		p, root = strings.ToLower(p), strings.ToLower(root)
	}
	root = strings.TrimRight(root, string(filepath.Separator))
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

func cleanTag(s string) string {
	s = strings.ReplaceAll(s, ",", " ")
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > 60 {
		s = string(r[:60])
	}
	return s
}

func autoColor(name string) string {
	h := fnv.New32a()
	h.Write([]byte(strings.ToLower(name)))
	return tagPalette[int(h.Sum32())%len(tagPalette)]
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func hasTag(tags []string, t string) bool {
	for _, x := range tags {
		if x == t {
			return true
		}
	}
	return false
}

func sortTags(t []string) {
	sort.Slice(t, func(i, j int) bool { return strings.ToLower(t[i]) < strings.ToLower(t[j]) })
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func naturalLess(a, b string) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := a[i], b[j]
		if isDigit(ca) && isDigit(cb) {
			si := i
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			sj := j
			for j < len(b) && isDigit(b[j]) {
				j++
			}
			na, nb := strings.TrimLeft(a[si:i], "0"), strings.TrimLeft(b[sj:j], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	return len(a)-i < len(b)-j
}

func orphanKey(name string, size, mtime int64) string {
	return fmt.Sprintf("%s|%d|%d", strings.ToLower(name), size, mtime)
}

func recFromInfo(path string, st fs.FileInfo) *FileRec {
	ext := strings.ToLower(filepath.Ext(path))
	f := &FileRec{ID: fileID(path), Path: path, Name: filepath.Base(path), Dir: filepath.Dir(path),
		Ext: ext, Kind: kindOf(ext), Size: st.Size(), MTime: st.ModTime().Unix(), Added: time.Now().Unix(), IsDir: st.IsDir()}
	if f.IsDir {
		f.Kind, f.Ext, f.Size = "folder", "", 0
	}
	return f
}

// ---------- load / save ----------

func LoadLibrary(dir string) (*Library, error) {
	l := &Library{
		path:    filepath.Join(dir, "library.json"),
		Version: 2,
		Files:   map[string]*FileRec{},
		Tags:    map[string]*TagInfo{},
		tagIdx:  map[string]string{},
		orphans: map[string][]string{},
		Prefs:   Prefs{WatchDownloads: true},
	}
	b, err := os.ReadFile(l.path)
	oldVersion := 2
	switch {
	case err == nil:
		if jerr := json.Unmarshal(b, l); jerr != nil {
			log.Printf("library.json is unreadable (%v); trying backup", jerr)
			_ = os.Rename(l.path, l.path+".corrupt-"+time.Now().Format("20060102-150405"))
			l.Files, l.Tags = map[string]*FileRec{}, map[string]*TagInfo{}
			if bb, berr := os.ReadFile(l.path + ".bak"); berr == nil {
				if json.Unmarshal(bb, l) != nil {
					l.Files, l.Tags = map[string]*FileRec{}, map[string]*TagInfo{}
				}
			}
		} else {
			oldVersion = l.Version
			if oldVersion < 2 {
				// Keep a copy of the version-1 library before converting it.
				_ = os.WriteFile(filepath.Join(dir, "library.v1.backup.json"), b, 0o644)
			} else {
				_ = os.WriteFile(l.path+".bak", b, 0o644)
			}
		}
	case !errors.Is(err, fs.ErrNotExist):
		return nil, err
	}
	if l.Files == nil {
		l.Files = map[string]*FileRec{}
	}
	if l.Tags == nil {
		l.Tags = map[string]*TagInfo{}
	}
	if oldVersion < 2 {
		// v1 scanned whole folders; v2 only remembers files that carry tags or a rating,
		// and the old library folders become pinned folders in the tree.
		for _, r := range l.Roots {
			l.Pins = append(l.Pins, r)
		}
		l.Roots = nil
		for id, f := range l.Files {
			if len(f.Tags) == 0 && f.Rating == 0 {
				delete(l.Files, id)
			}
		}
		l.Version = 2
		defer func() { _ = l.Flush() }()
	}
	for _, f := range l.Files {
		if f.ID == "" {
			f.ID = fileID(f.Path)
		}
		for _, t := range f.Tags {
			if _, ok := l.Tags[t]; !ok {
				l.Tags[t] = &TagInfo{Color: autoColor(t)}
			}
		}
	}
	for name := range l.Tags {
		l.tagIdx[strings.ToLower(name)] = name
	}
	return l, nil
}

func (l *Library) Flush() error {
	l.mu.RLock()
	b, err := json.Marshal(l)
	l.mu.RUnlock()
	if err != nil {
		return err
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}

// touch schedules a save; the caller must hold the write lock.
func (l *Library) touch() {
	l.rev++
	if l.timer != nil {
		return
	}
	l.timer = time.AfterFunc(900*time.Millisecond, func() {
		l.mu.Lock()
		l.timer = nil
		l.mu.Unlock()
		if err := l.Flush(); err != nil {
			log.Printf("save failed: %v", err)
		}
	})
}

// canon returns the stored spelling for a tag, creating it if needed. Caller holds the write lock.
func (l *Library) canon(name string) string {
	name = cleanTag(name)
	if name == "" {
		return ""
	}
	key := strings.ToLower(name)
	if c, ok := l.tagIdx[key]; ok {
		return c
	}
	l.tagIdx[key] = name
	l.Tags[name] = &TagInfo{Color: autoColor(name)}
	return name
}

func (l *Library) Lookup(path string) *FileRec {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if f, ok := l.Files[fileID(path)]; ok {
		c := *f
		return &c
	}
	return nil
}

// ---------- listing support ----------

// Annotate fills in tags and ratings for directory entries and re-attaches tags to files that
// were moved or renamed outside TagShelf (matched by name, size and modified time).
func (l *Library) Annotate(entries []Entry) (relinked int) {
	var cands []int
	l.mu.RLock()
	hasOrphans := len(l.orphans) > 0
	for i := range entries {
		e := &entries[i]
		if f, ok := l.Files[fileID(e.Path)]; ok {
			e.Tags, e.Rating = f.Tags, f.Rating
		} else if hasOrphans && !e.IsDir {
			cands = append(cands, i)
		}
	}
	l.mu.RUnlock()
	if len(cands) == 0 {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, i := range cands {
		e := &entries[i]
		k := orphanKey(e.Name, e.Size, e.MTime)
		ids := l.orphans[k]
		if len(ids) == 0 {
			continue
		}
		old := l.Files[ids[0]]
		l.orphans[k] = ids[1:]
		if len(l.orphans[k]) == 0 {
			delete(l.orphans, k)
		}
		if old == nil {
			continue
		}
		delete(l.Files, old.ID)
		old.Path, old.Name, old.Dir, old.ID, old.Missing = e.Path, e.Name, filepath.Dir(e.Path), fileID(e.Path), false
		l.Files[old.ID] = old
		e.Tags, e.Rating = old.Tags, old.Rating
		relinked++
		vecs.Rekey(map[string]string{ids[0]: old.ID}, map[string]string{old.ID: e.Path})
	}
	if relinked > 0 {
		l.touch()
	}
	return relinked
}

// CheckMissing flags remembered files that no longer exist and indexes them for relinking.
func (l *Library) CheckMissing() {
	l.mu.RLock()
	type idp struct{ id, p string }
	snap := make([]idp, 0, len(l.Files))
	for id, f := range l.Files {
		snap = append(snap, idp{id, f.Path})
	}
	l.mu.RUnlock()
	gone := map[string]bool{}
	for _, s := range snap {
		if _, err := os.Lstat(s.p); err != nil && errors.Is(err, fs.ErrNotExist) {
			gone[s.id] = true
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.orphans = map[string][]string{}
	for id, f := range l.Files {
		f.Missing = gone[id]
		if f.Missing && !f.IsDir {
			k := orphanKey(f.Name, f.Size, f.MTime)
			l.orphans[k] = append(l.orphans[k], id)
		}
	}
}

func (l *Library) MissingList() []FileRec {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := []FileRec{}
	for _, f := range l.Files {
		if f.Missing {
			out = append(out, *f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return naturalLess(strings.ToLower(out[i].Path), strings.ToLower(out[j].Path)) })
	return out
}

func (l *Library) PurgeMissing(ids []string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	n := 0
	for id, f := range l.Files {
		if f.Missing && (len(want) == 0 || want[id]) {
			delete(l.Files, id)
			n++
		}
	}
	if n > 0 {
		l.touch()
	}
	return n
}

// ---------- moves, copies ----------

type Pair struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Relocate follows files and folders that were moved or renamed through TagShelf.
func (l *Library) Relocate(pairs []Pair) {
	if len(pairs) == 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	type mv struct {
		old string
		f   *FileRec
	}
	var moves []mv
	idMap, pathMap := map[string]string{}, map[string]string{}
	for id, f := range l.Files {
		for _, p := range pairs {
			var np string
			switch {
			case samePath(f.Path, p.From):
				np = p.To
			case underRoot(f.Path, p.From):
				np = p.To + f.Path[len(strings.TrimRight(p.From, string(filepath.Separator))):]
			default:
				continue
			}
			f.Path, f.Name, f.Dir = np, filepath.Base(np), filepath.Dir(np)
			if !f.IsDir {
				f.Ext = strings.ToLower(filepath.Ext(np))
				f.Kind = kindOf(f.Ext)
			}
			moves = append(moves, mv{id, f})
			break
		}
	}
	for _, m := range moves {
		delete(l.Files, m.old)
	}
	for _, m := range moves {
		m.f.ID = fileID(m.f.Path)
		m.f.Missing = false
		l.Files[m.f.ID] = m.f
		idMap[m.old] = m.f.ID
		pathMap[m.f.ID] = m.f.Path
	}
	if len(moves) > 0 {
		vecs.Rekey(idMap, pathMap)
		l.touch()
	}
	// vectors also exist for untagged files, so follow those too
	vecs.RelocatePaths(pairs)
}

// CopyMeta gives copies the same tags and rating as their originals.
func (l *Library) CopyMeta(pairs []Pair) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, p := range pairs {
		src := l.Files[fileID(p.From)]
		if src == nil {
			vecs.Copy(p.From, p.To)
			continue
		}
		st, err := os.Stat(p.To)
		if err != nil {
			continue
		}
		nf := recFromInfo(p.To, st)
		nf.Tags = append([]string{}, src.Tags...)
		nf.Rating = src.Rating
		l.Files[nf.ID] = nf
		vecs.Copy(p.From, p.To)
		n++
	}
	if n > 0 {
		l.touch()
	}
}

// ---------- tag & metadata mutations ----------

func (l *Library) ensureLocked(path string) (*FileRec, error) {
	id := fileID(path)
	if f, ok := l.Files[id]; ok {
		return f, nil
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	f := recFromInfo(path, st)
	l.Files[id] = f
	return f, nil
}

func (l *Library) TagPaths(paths, add, remove []string) (map[string][]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var addC []string
	for _, a := range add {
		if c := l.canon(a); c != "" {
			addC = append(addC, c)
		}
	}
	rem := map[string]bool{}
	for _, r := range remove {
		if c, ok := l.tagIdx[strings.ToLower(cleanTag(r))]; ok {
			rem[c] = true
		}
	}
	now := time.Now().Unix()
	for _, a := range addC {
		l.Tags[a].Used = now
	}
	out := map[string][]string{}
	var firstErr error
	for _, p := range paths {
		id := fileID(p)
		f := l.Files[id]
		if f == nil {
			if len(addC) == 0 {
				continue
			}
			var err error
			if f, err = l.ensureLocked(p); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
		}
		nt := make([]string, 0, len(f.Tags)+len(addC))
		for _, t := range f.Tags {
			if !rem[t] {
				nt = append(nt, t)
			}
		}
		for _, a := range addC {
			if !hasTag(nt, a) {
				nt = append(nt, a)
			}
		}
		sortTags(nt)
		f.Tags = nt
		out[p] = append([]string{}, nt...)
		if len(nt) == 0 && f.Rating == 0 {
			delete(l.Files, id)
		}
	}
	l.touch()
	return out, firstErr
}

// SetExactTags sets exact tag lists (used by undo).
func (l *Library) SetExactTags(items map[string][]string) map[string][]string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string][]string{}
	for p, tags := range items {
		var nt []string
		for _, t := range tags {
			if c := l.canon(t); c != "" && !hasTag(nt, c) {
				nt = append(nt, c)
			}
		}
		sortTags(nt)
		id := fileID(p)
		f := l.Files[id]
		if f == nil {
			if len(nt) == 0 {
				out[p] = nil
				continue
			}
			var err error
			if f, err = l.ensureLocked(p); err != nil {
				continue
			}
		}
		f.Tags = nt
		out[p] = append([]string{}, nt...)
		if len(nt) == 0 && f.Rating == 0 {
			delete(l.Files, id)
		}
	}
	l.touch()
	return out
}

func (l *Library) SetRating(paths []string, r int) {
	if r < 0 {
		r = 0
	}
	if r > 5 {
		r = 5
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, p := range paths {
		id := fileID(p)
		f := l.Files[id]
		if f == nil && r > 0 {
			f, _ = l.ensureLocked(p)
		}
		if f == nil {
			continue
		}
		f.Rating = r
		if r == 0 && len(f.Tags) == 0 {
			delete(l.Files, id)
		}
	}
	l.touch()
}

func (l *Library) CreateTag(name string) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c := l.canon(name)
	if c == "" {
		return "", errors.New("tag name is empty")
	}
	l.touch()
	return c, nil
}

func (l *Library) RenameTag(from, to string) error {
	to = cleanTag(to)
	if to == "" {
		return errors.New("tag name is empty")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	src, ok := l.tagIdx[strings.ToLower(cleanTag(from))]
	if !ok {
		return errors.New("no such tag")
	}
	dst := to
	existing, exists := l.tagIdx[strings.ToLower(to)]
	merge := exists && !strings.EqualFold(existing, src)
	if merge {
		dst = existing
	}
	for _, f := range l.Files {
		if !hasTag(f.Tags, src) {
			continue
		}
		nt := make([]string, 0, len(f.Tags))
		for _, t := range f.Tags {
			if t != src {
				nt = append(nt, t)
			}
		}
		if !hasTag(nt, dst) {
			nt = append(nt, dst)
		}
		sortTags(nt)
		f.Tags = nt
	}
	for id, rej := range l.Rejected {
		for i, t := range rej {
			if t == src {
				rej[i] = dst
			}
		}
		l.Rejected[id] = rej
	}
	info := l.Tags[src]
	delete(l.Tags, src)
	delete(l.tagIdx, strings.ToLower(src))
	if !merge {
		color, used := autoColor(dst), int64(0)
		if info != nil {
			color, used = info.Color, info.Used
		}
		l.Tags[dst] = &TagInfo{Color: color, Used: used}
		l.tagIdx[strings.ToLower(dst)] = dst
	}
	l.touch()
	return nil
}

func (l *Library) DeleteTag(name string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.tagIdx[strings.ToLower(cleanTag(name))]
	if !ok {
		return
	}
	for id, f := range l.Files {
		if hasTag(f.Tags, c) {
			nt := make([]string, 0, len(f.Tags))
			for _, t := range f.Tags {
				if t != c {
					nt = append(nt, t)
				}
			}
			f.Tags = nt
			if len(nt) == 0 && f.Rating == 0 {
				delete(l.Files, id)
			}
		}
	}
	delete(l.Tags, c)
	delete(l.tagIdx, strings.ToLower(c))
	l.touch()
}

func (l *Library) SetTagColor(name, color string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if c, ok := l.tagIdx[strings.ToLower(cleanTag(name))]; ok && len(color) == 7 && color[0] == '#' {
		l.Tags[c].Color = color
		l.touch()
	}
}

func (l *Library) SaveView(name string, state json.RawMessage) View {
	name = strings.TrimSpace(name)
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.Views {
		if strings.EqualFold(l.Views[i].Name, name) {
			l.Views[i].State = state
			l.touch()
			return l.Views[i]
		}
	}
	v := View{ID: randHex(4), Name: name, State: state}
	l.Views = append(l.Views, v)
	l.touch()
	return v
}

func (l *Library) DeleteView(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var keep []View
	for _, v := range l.Views {
		if v.ID != id {
			keep = append(keep, v)
		}
	}
	l.Views = keep
	l.touch()
}

func (l *Library) SetSettings(raw json.RawMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.Settings = raw
	l.touch()
}

func (l *Library) SetPin(path string, on bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var keep []string
	for _, p := range l.Pins {
		if !samePath(p, path) {
			keep = append(keep, p)
		}
	}
	if on {
		keep = append(keep, path)
	}
	l.Pins = keep
	l.touch()
}

func (l *Library) AddRecentDir(p string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []string{p}
	for _, r := range l.Recent {
		if !samePath(r, p) && len(out) < 8 {
			out = append(out, r)
		}
	}
	l.Recent = out
	l.touch()
}

func (l *Library) Reject(paths []string, tag string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Rejected == nil {
		l.Rejected = map[string][]string{}
	}
	for _, p := range paths {
		id := fileID(p)
		if !hasTag(l.Rejected[id], tag) {
			l.Rejected[id] = append(l.Rejected[id], tag)
		}
	}
	l.touch()
}

func (l *Library) SetPrefs(p Prefs) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.Prefs = p
	l.touch()
}

type TagOut struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	Count int    `json:"count"`
	Used  int64  `json:"used"`
}

func (l *Library) TagList() []TagOut {
	l.mu.RLock()
	defer l.mu.RUnlock()
	counts := map[string]int{}
	for _, f := range l.Files {
		for _, t := range f.Tags {
			counts[t]++
		}
	}
	out := make([]TagOut, 0, len(l.Tags))
	for n, ti := range l.Tags {
		out = append(out, TagOut{Name: n, Color: ti.Color, Count: counts[n], Used: ti.Used})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}
