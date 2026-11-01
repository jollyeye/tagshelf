package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed web/*
var webFS embed.FS

const appVersion = "2.0"

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
	".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv",
	".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg", ".wma": "audio/x-ms-wma",
	".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
}

func init() {
	// Windows takes MIME types from the registry, which is sometimes wrong; pin the ones we need.
	for ext, ct := range contentTypes {
		_ = mime.AddExtensionType(ext, ct)
	}
}

type Server struct {
	lib       *Library
	ai        *AI
	dataDir   string
	token     string
	port      int
	bgFlag    bool
	quit      chan struct{}
	quitOnce  sync.Once
	lastPing  atomic.Int64
	byeAt     atomic.Int64
	popupPing atomic.Int64
	popupLast atomic.Int64
	watch     *Watcher
}

func newServer(lib *Library, dataDir, token string, port int) *Server {
	s := &Server{lib: lib, ai: &AI{lib: lib}, dataDir: dataDir, token: token, port: port, quit: make(chan struct{})}
	s.lastPing.Store(time.Now().UnixNano())
	s.watch = newWatcher(s)
	return s
}

func (s *Server) Quit() { s.quitOnce.Do(func() { close(s.quit) }) }

func (s *Server) backgroundMode() bool {
	s.lib.mu.RLock()
	defer s.lib.mu.RUnlock()
	return s.bgFlag || s.lib.Prefs.Background
}

// ---------- plumbing ----------

func api[T any](fn func(r *http.Request, in T) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in T
		if r.Method != http.MethodGet && r.ContentLength != 0 {
			if err := decode(r, &in); err != nil && !errors.Is(err, io.EOF) {
				fail(w, 400, err)
				return
			}
		}
		out, err := fn(r, in)
		if err != nil {
			code := 400
			if errors.Is(err, fs.ErrNotExist) {
				code = 404
			}
			fail(w, code, err)
			return
		}
		writeJSON(w, out)
	}
}

type none struct{}

var ok = map[string]bool{"ok": true}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		s.lastPing.Store(time.Now().UnixNano())
		writeJSON(w, map[string]string{"app": "tagshelf"})
	})
	mux.HandleFunc("GET /api/popup/ping", func(w http.ResponseWriter, r *http.Request) {
		s.popupPing.Store(time.Now().UnixNano())
		writeJSON(w, ok)
	})
	mux.HandleFunc("POST /api/bye", func(w http.ResponseWriter, r *http.Request) {
		s.byeAt.Store(time.Now().UnixNano())
		writeJSON(w, ok)
	})
	mux.HandleFunc("POST /api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, ok)
		go func() { time.Sleep(200 * time.Millisecond); s.Quit() }()
	})
	mux.HandleFunc("GET /api/state", api(s.apiState))
	mux.HandleFunc("GET /api/locations", api(func(r *http.Request, _ none) (any, error) {
		return map[string]any{"quick": quickPlaces(), "drives": listDrives()}, nil
	}))
	mux.HandleFunc("GET /api/tree", api(s.apiTree))
	mux.HandleFunc("GET /api/list", api(s.apiList))
	mux.HandleFunc("POST /api/mkdir", api(func(r *http.Request, in struct{ Parent, Name string }) (any, error) {
		p, err := makeDir(in.Parent, in.Name)
		return map[string]string{"path": p}, err
	}))
	mux.HandleFunc("POST /api/rename", api(func(r *http.Request, in struct{ Path, Name string }) (any, error) {
		np, err := renameEntry(in.Path, in.Name)
		if err != nil {
			return nil, err
		}
		s.lib.Relocate([]Pair{{in.Path, np}})
		return map[string]string{"path": np}, nil
	}))
	mux.HandleFunc("POST /api/move", api(func(r *http.Request, in struct {
		Paths []string
		Dest  string
	}) (any, error) {
		d, err := cleanAbs(in.Dest)
		if err != nil {
			return nil, err
		}
		res := moveEntries(s.lib, in.Paths, d)
		s.lib.AddRecentDir(d)
		return res, nil
	}))
	mux.HandleFunc("POST /api/copy", api(func(r *http.Request, in struct {
		Paths []string
		Dest  string
	}) (any, error) {
		d, err := cleanAbs(in.Dest)
		if err != nil {
			return nil, err
		}
		return copyEntries(s.lib, in.Paths, d), nil
	}))
	mux.HandleFunc("POST /api/trash", api(func(r *http.Request, in struct{ Paths []string }) (any, error) {
		if err := trashPaths(s.dataDir, in.Paths); err != nil {
			return nil, err
		}
		go s.lib.CheckMissing()
		return ok, nil
	}))
	mux.HandleFunc("POST /api/open", api(func(r *http.Request, in struct {
		Path   string
		Reveal bool
	}) (any, error) {
		if !exists(in.Path) {
			return nil, fs.ErrNotExist
		}
		return ok, openPath(in.Path, in.Reveal)
	}))
	mux.HandleFunc("POST /api/pick", s.handlePick)
	mux.HandleFunc("POST /api/pin", api(func(r *http.Request, in struct {
		Path string
		On   bool
	}) (any, error) {
		s.lib.SetPin(in.Path, in.On)
		return ok, nil
	}))

	// tags
	mux.HandleFunc("POST /api/tags/apply", api(func(r *http.Request, in struct{ Paths, Add, Remove []string }) (any, error) {
		out, err := s.lib.TagPaths(in.Paths, in.Add, in.Remove)
		if err != nil && len(out) == 0 {
			return nil, err
		}
		return map[string]any{"tags": out, "all": s.lib.TagList()}, nil
	}))
	mux.HandleFunc("POST /api/tags/set", api(func(r *http.Request, in struct{ Items map[string][]string }) (any, error) {
		return map[string]any{"tags": s.lib.SetExactTags(in.Items), "all": s.lib.TagList()}, nil
	}))
	mux.HandleFunc("POST /api/rate", api(func(r *http.Request, in struct {
		Paths  []string
		Rating int
	}) (any, error) {
		s.lib.SetRating(in.Paths, in.Rating)
		return ok, nil
	}))
	mux.HandleFunc("POST /api/tag/create", api(func(r *http.Request, in struct{ Name string }) (any, error) {
		n, err := s.lib.CreateTag(in.Name)
		return map[string]any{"name": n, "all": s.lib.TagList()}, err
	}))
	mux.HandleFunc("POST /api/tag/rename", api(func(r *http.Request, in struct{ From, To string }) (any, error) {
		err := s.lib.RenameTag(in.From, in.To)
		return map[string]any{"all": s.lib.TagList()}, err
	}))
	mux.HandleFunc("POST /api/tag/delete", api(func(r *http.Request, in struct{ Name string }) (any, error) {
		s.lib.DeleteTag(in.Name)
		return map[string]any{"all": s.lib.TagList()}, nil
	}))
	mux.HandleFunc("POST /api/tag/color", api(func(r *http.Request, in struct{ Name, Color string }) (any, error) {
		s.lib.SetTagColor(in.Name, in.Color)
		return map[string]any{"all": s.lib.TagList()}, nil
	}))
	mux.HandleFunc("POST /api/views", api(func(r *http.Request, in struct {
		Name  string
		State json.RawMessage
	}) (any, error) {
		if strings.TrimSpace(in.Name) == "" {
			return nil, errors.New("give the filter a name")
		}
		s.lib.SaveView(in.Name, in.State)
		s.lib.mu.RLock()
		defer s.lib.mu.RUnlock()
		return map[string]any{"views": s.lib.Views}, nil
	}))
	mux.HandleFunc("POST /api/views/delete", api(func(r *http.Request, in struct{ ID string }) (any, error) {
		s.lib.DeleteView(in.ID)
		s.lib.mu.RLock()
		defer s.lib.mu.RUnlock()
		return map[string]any{"views": s.lib.Views}, nil
	}))
	mux.HandleFunc("POST /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var raw json.RawMessage
		if err := decode(r, &raw); err != nil {
			fail(w, 400, err)
			return
		}
		s.lib.SetSettings(raw)
		writeJSON(w, ok)
	})
	mux.HandleFunc("POST /api/prefs", api(s.apiPrefs))
	mux.HandleFunc("GET /api/missing", api(func(r *http.Request, _ none) (any, error) {
		return map[string]any{"files": s.lib.MissingList()}, nil
	}))
	mux.HandleFunc("POST /api/missing/purge", api(func(r *http.Request, in struct{ IDs []string }) (any, error) {
		return map[string]int{"purged": s.lib.PurgeMissing(in.IDs)}, nil
	}))

	// AI (suggestions only)
	mux.HandleFunc("POST /api/ai/need", api(s.apiAINeed))
	mux.HandleFunc("POST /api/ai/vec", api(s.apiAIVec))
	mux.HandleFunc("POST /api/ai/suggest", api(func(r *http.Request, in struct{ Paths []string }) (any, error) {
		if len(in.Paths) > 200 {
			in.Paths = in.Paths[:200]
		}
		return s.ai.Suggest(in.Paths, false), nil
	}))
	mux.HandleFunc("POST /api/ai/reject", api(func(r *http.Request, in struct {
		Paths []string
		Tag   string
	}) (any, error) {
		s.lib.Reject(in.Paths, in.Tag)
		return ok, nil
	}))
	mux.HandleFunc("POST /api/ai/queue", api(func(r *http.Request, in struct{ Limit int }) (any, error) {
		if in.Limit <= 0 || in.Limit > 100 {
			in.Limit = 20
		}
		p, n := s.ai.Backlog(in.Limit)
		if p == nil {
			p = []string{}
		}
		return map[string]any{"paths": p, "total": n, "vectors": vecs.Count()}, nil
	}))
	mux.HandleFunc("POST /api/ai/test", api(func(r *http.Request, _ none) (any, error) { return s.ai.Test(300), nil }))
	mux.HandleFunc("POST /api/dups", api(s.apiDups))
	mux.HandleFunc("POST /api/ai/similar", api(func(r *http.Request, in struct {
		Path string
		N    int
	}) (any, error) {
		if in.N <= 0 || in.N > 100 {
			in.N = 40
		}
		items, need := s.ai.FindSimilar(in.Path, in.N)
		return map[string]any{"items": items, "need": need}, nil
	}))

	// downloads
	mux.HandleFunc("GET /api/downloads", api(func(r *http.Request, _ none) (any, error) {
		return map[string]any{"items": s.watch.Pending()}, nil
	}))
	mux.HandleFunc("POST /api/downloads/done", api(s.apiDownloadDone))
	mux.HandleFunc("POST /api/downloads/skip", api(func(r *http.Request, in struct {
		ID  string
		All bool
	}) (any, error) {
		s.watch.Drop(in.ID, in.All)
		return ok, nil
	}))

	mux.HandleFunc("GET /file", s.handleFile)
	mux.HandleFunc("GET /thumb", s.handleThumb)
	mux.HandleFunc("GET /", s.handleStatic)
	return s.guard(mux)
}

// guard protects the local API from other web pages and other local users' browsers:
// the Host header must be ours (anti DNS-rebinding), the session cookie must match the
// per-launch token, and state-changing requests need a custom header.
func (s *Server) guard(next http.Handler) http.Handler {
	hostA := fmt.Sprintf("127.0.0.1:%d", s.port)
	hostB := fmt.Sprintf("localhost:%d", s.port)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != hostA && r.Host != hostB {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if t := r.URL.Query().Get("t"); t != "" && (r.URL.Path == "/" || r.URL.Path == "/popup.html") {
			if subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1 {
				http.SetCookie(w, &http.Cookie{Name: "tagshelf", Value: s.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
				http.Redirect(w, r, r.URL.Path, http.StatusSeeOther)
				return
			}
		}
		c, err := r.Cookie("tagshelf")
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.token)) != 1 {
			http.Error(w, "Please open TagShelf from its own window (start TagShelf.exe).", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.URL.Path != "/api/bye" && r.Header.Get("X-TagShelf") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(v)
}

// ---------- API handlers ----------

func (s *Server) apiState(r *http.Request, _ none) (any, error) {
	s.lib.mu.RLock()
	missing := 0
	for _, f := range s.lib.Files {
		if f.Missing {
			missing++
		}
	}
	st := map[string]any{
		"pins": s.lib.Pins, "views": s.lib.Views, "settings": s.lib.Settings, "prefs": s.lib.Prefs,
		"recent": s.lib.Recent, "missing": missing, "os": runtime.GOOS, "sep": string(filepath.Separator),
		"version": appVersion, "downloads": defaultDownloads(),
	}
	s.lib.mu.RUnlock()
	st["tags"] = s.lib.TagList()
	st["vectors"] = vecs.Count()
	st["autostart"] = autostartGet()
	st["pending"] = len(s.watch.Pending())
	if home, err := os.UserHomeDir(); err == nil {
		st["home"] = home
	}
	return st, nil
}

func (s *Server) apiTree(r *http.Request, _ none) (any, error) {
	p, err := cleanAbs(r.URL.Query().Get("path"))
	if err != nil {
		return nil, err
	}
	kids, err := treeChildren(p, r.URL.Query().Get("hidden") == "1")
	if err != nil {
		return nil, err
	}
	if kids == nil {
		kids = []TreeNode{}
	}
	return map[string]any{"children": kids}, nil
}

func (s *Server) apiList(r *http.Request, _ none) (any, error) {
	q := r.URL.Query()
	p, err := cleanAbs(q.Get("path"))
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return nil, friendlyErr(err)
	}
	if !st.IsDir() {
		return nil, errors.New("that is not a folder")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	entries, trunc, err := listDir(ctx, p, q.Get("sub") == "1", q.Get("hidden") == "1", 300000)
	if err != nil {
		return nil, err
	}
	relinked := s.lib.Annotate(entries)
	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}
	if entries == nil {
		entries = []Entry{}
	}
	return map[string]any{"path": p, "parent": parent, "entries": entries, "truncated": trunc, "relinked": relinked}, nil
}

func (s *Server) apiPrefs(r *http.Request, in struct {
	WatchDownloads *bool
	WatchDirs      *[]string
	Background     *bool
	Autostart      *bool
}) (any, error) {
	s.lib.mu.RLock()
	p := s.lib.Prefs
	s.lib.mu.RUnlock()
	if in.WatchDownloads != nil {
		p.WatchDownloads = *in.WatchDownloads
	}
	if in.WatchDirs != nil {
		var dirs []string
		for _, d := range *in.WatchDirs {
			if c, err := cleanAbs(d); err == nil {
				dirs = append(dirs, c)
			}
		}
		p.WatchDirs = dirs
	}
	if in.Background != nil {
		p.Background = *in.Background
	}
	s.lib.SetPrefs(p)
	var msg string
	if in.Autostart != nil {
		if err := autostartSet(*in.Autostart); err != nil {
			msg = err.Error()
		}
	}
	return map[string]any{"prefs": p, "autostart": autostartGet(), "warning": msg}, nil
}

func (s *Server) apiAINeed(r *http.Request, in struct{ Paths []string }) (any, error) {
	need := []string{}
	for _, p := range in.Paths {
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			continue
		}
		if k := kindOf(strings.ToLower(filepath.Ext(p))); k != "image" && k != "video" {
			continue
		}
		if vecs.Get(fileID(p), st.ModTime().Unix(), st.Size()) == nil {
			need = append(need, p)
		}
	}
	return map[string]any{"need": need}, nil
}

func (s *Server) apiAIVec(r *http.Request, in struct {
	Items []struct {
		Path string
		Vec  []float64
	}
}) (any, error) {
	n := 0
	for _, it := range in.Items {
		st, err := os.Stat(it.Path)
		if err != nil || st.IsDir() {
			continue
		}
		if err := vecs.Put(it.Path, st.ModTime().Unix(), st.Size(), it.Vec); err == nil {
			n++
		}
	}
	return map[string]int{"stored": n}, nil
}

func (s *Server) apiDownloadDone(r *http.Request, in struct {
	ID     string
	Tags   []string
	MoveTo string
}) (any, error) {
	it := s.watch.Find(in.ID)
	if it == nil {
		return nil, errors.New("that download is no longer in the list")
	}
	path := it.Path
	if !exists(path) {
		s.watch.Drop(in.ID, false)
		return nil, errors.New("the file has been moved or deleted")
	}
	if strings.TrimSpace(in.MoveTo) != "" {
		d, err := cleanAbs(in.MoveTo)
		if err != nil {
			return nil, err
		}
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			return nil, errors.New("the folder to move to doesn't exist")
		}
		res := moveEntries(s.lib, []string{path}, d)
		if len(res.Errors) > 0 {
			return nil, errors.New(res.Errors[0])
		}
		if len(res.Done) > 0 {
			path = res.Done[0].To
		}
		s.lib.AddRecentDir(d)
	}
	if len(in.Tags) > 0 {
		if _, err := s.lib.TagPaths([]string{path}, in.Tags, nil); err != nil {
			return nil, err
		}
	}
	s.watch.Drop(in.ID, false)
	return map[string]any{"path": path, "all": s.lib.TagList()}, nil
}

func (s *Server) handlePick(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "windows" {
		fail(w, 501, errors.New("the folder picker only works on Windows - type the folder path instead"))
		return
	}
	script := `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Choose a folder'
$f.ShowNewFolderButton = $true
if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }`
	cmd := exec.CommandContext(r.Context(), "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		fail(w, 500, fmt.Errorf("couldn't open the folder picker: %v", err))
		return
	}
	writeJSON(w, map[string]string{"path": strings.TrimSpace(strings.TrimPrefix(string(out), "\xef\xbb\xbf"))})
}

// ---------- static files, media ----------

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	sub, _ := fs.Sub(webFS, "web")
	b, err := fs.ReadFile(sub, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := contentTypes[strings.ToLower(filepath.Ext(name))]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
	_, _ = w.Write(b)
}

func queryFile(r *http.Request) (string, fs.FileInfo, error) {
	p, err := cleanAbs(r.URL.Query().Get("p"))
	if err != nil {
		return "", nil, err
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return "", nil, fs.ErrNotExist
	}
	return p, st, nil
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	p, st, err := queryFile(r)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	fh, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer fh.Close()
	if ct := contentTypes[strings.ToLower(filepath.Ext(p))]; ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), fh)
}

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	p, st, err := queryFile(r)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f := recFromInfo(p, st)
	if f.Kind != "image" || !thumbExts[f.Ext] {
		http.Redirect(w, r, "/file?p="+strings.ReplaceAll(strings.ReplaceAll(r.URL.Query().Get("p"), "%", "%25"), "&", "%26"), http.StatusFound)
		return
	}
	dst := thumbPath(s.dataDir, f)
	if _, err := os.Stat(dst); err != nil {
		if err := makeThumb(p, dst, f.Ext); err != nil {
			log.Printf("thumbnail failed for %s: %v", p, err)
			http.Redirect(w, r, "/file?p="+strings.ReplaceAll(strings.ReplaceAll(r.URL.Query().Get("p"), "%", "%25"), "&", "%26"), http.StatusFound)
			return
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeFile(w, r, dst)
}

var _ = strconv.Itoa

// ---------- start with Windows ----------

const runKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

func autostartGet() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	cmd := exec.Command("reg.exe", "query", runKey, "/v", "TagShelf")
	hideWindow(cmd)
	return cmd.Run() == nil
}

func autostartSet(on bool) error {
	if runtime.GOOS != "windows" {
		return errors.New("starting with the computer is only available on Windows")
	}
	var cmd *exec.Cmd
	if on {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		cmd = exec.Command("reg.exe", "add", runKey, "/v", "TagShelf", "/t", "REG_SZ", "/d", `"`+exe+`" --background`, "/f")
	} else {
		cmd = exec.Command("reg.exe", "delete", runKey, "/v", "TagShelf", "/f")
	}
	hideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		if !on && strings.Contains(strings.ToLower(string(out)), "unable to find") {
			return nil
		}
		return fmt.Errorf("couldn't change the start-up setting: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
