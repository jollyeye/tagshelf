package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type Entry struct {
	Name   string   `json:"n"`
	Path   string   `json:"p"`
	IsDir  bool     `json:"d,omitempty"`
	Kind   string   `json:"k"`
	Ext    string   `json:"x,omitempty"`
	Size   int64    `json:"s"`
	MTime  int64    `json:"m"`
	Tags   []string `json:"t,omitempty"`
	Rating int      `json:"r,omitempty"`
	Hidden bool     `json:"h,omitempty"`
	Rel    string   `json:"rel,omitempty"`
}

type TreeNode struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type Drive struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type Place struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Icon string `json:"icon"`
}

func cleanAbs(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || !filepath.IsAbs(p) {
		return "", errors.New("that is not a full folder path")
	}
	return filepath.Clean(p), nil
}

func entryFrom(dir, name string, info fs.FileInfo) Entry {
	full := filepath.Join(dir, name)
	e := Entry{Name: name, Path: full, IsDir: info.IsDir(), Size: info.Size(), MTime: info.ModTime().Unix(),
		Hidden: isHiddenInfo(info, name)}
	if e.IsDir {
		e.Kind, e.Size = "folder", 0
	} else {
		e.Ext = strings.ToLower(filepath.Ext(name))
		e.Kind = kindOf(e.Ext)
	}
	return e
}

func friendlyErr(err error) error {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return errors.New("Windows says you don't have permission to open this")
	case errors.Is(err, fs.ErrNotExist):
		return errors.New("this folder or file no longer exists")
	}
	return err
}

func listDir(ctx context.Context, root string, recursive, showHidden bool, limit int) ([]Entry, bool, error) {
	var out []Entry
	if !recursive {
		des, err := os.ReadDir(root)
		if err != nil {
			return nil, false, friendlyErr(err)
		}
		out = make([]Entry, 0, len(des))
		for _, d := range des {
			info, err := d.Info()
			if err != nil {
				continue
			}
			if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
				if info, err = os.Stat(filepath.Join(root, d.Name())); err != nil {
					continue
				}
			}
			e := entryFrom(root, d.Name(), info)
			if e.Hidden && !showHidden {
				continue
			}
			out = append(out, e)
		}
		return out, false, nil
	}
	truncated := false
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if p == root {
				return err
			}
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if d.IsDir() {
			if p != root && !showHidden && isHiddenInfo(info, d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !showHidden && isHiddenInfo(info, d.Name()) {
			return nil
		}
		if len(out) >= limit {
			truncated = true
			return fs.SkipAll
		}
		e := entryFrom(filepath.Dir(p), d.Name(), info)
		if rel, rerr := filepath.Rel(root, filepath.Dir(p)); rerr == nil && rel != "." {
			e.Rel = rel
		}
		out = append(out, e)
		return nil
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		return nil, false, friendlyErr(err)
	}
	return out, truncated, nil
}

func treeChildren(path string, showHidden bool) ([]TreeNode, error) {
	des, err := os.ReadDir(path)
	if err != nil {
		return nil, friendlyErr(err)
	}
	var out []TreeNode
	for _, d := range des {
		full := filepath.Join(path, d.Name())
		isDir := d.IsDir()
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			st, err := os.Stat(full)
			if err != nil || !st.IsDir() {
				continue
			}
			isDir = true
		}
		if !isDir {
			continue
		}
		if info, err := d.Info(); err == nil && !showHidden && isHiddenInfo(info, d.Name()) {
			continue
		}
		out = append(out, TreeNode{Name: d.Name(), Path: full})
	}
	sort.Slice(out, func(i, j int) bool { return naturalLess(strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)) })
	return out, nil
}

func quickPlaces() []Place {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var out []Place
	add := func(name, icon string, cands ...string) {
		for _, c := range cands {
			if st, err := os.Stat(c); err == nil && st.IsDir() {
				out = append(out, Place{name, c, icon})
				return
			}
		}
	}
	od := os.Getenv("OneDrive")
	opt := func(n string) []string {
		l := []string{filepath.Join(home, n)}
		if od != "" {
			l = append(l, filepath.Join(od, n))
		}
		return l
	}
	out = append(out, Place{"Home", home, "home"})
	add("Desktop", "desktop", opt("Desktop")...)
	add("Downloads", "download", filepath.Join(home, "Downloads"))
	add("Documents", "doc", opt("Documents")...)
	add("Pictures", "image", opt("Pictures")...)
	vid := "Videos"
	if runtime.GOOS == "darwin" {
		vid = "Movies"
	}
	add("Videos", "video", opt(vid)...)
	add("Music", "music", opt("Music")...)
	return out
}

func defaultDownloads() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Downloads")
}

// ---------- names & conflicts ----------

func validName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return errors.New("that name is not allowed")
	}
	if strings.ContainsAny(name, `\/`) || strings.ContainsRune(name, 0) {
		return errors.New("a name can't contain slashes")
	}
	if isWin() {
		if strings.ContainsAny(name, `<>:"|?*`) {
			return errors.New(`a name can't contain any of  < > : " | ? *`)
		}
		if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
			return errors.New("a name can't end with a dot or a space")
		}
	}
	return nil
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if !exists(p) {
		return p
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		stem, ext = name, ""
	}
	for i := 2; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		if !exists(p) {
			return p
		}
	}
}

func makeDir(parent, name string) (string, error) {
	if err := validName(name); err != nil {
		return "", err
	}
	p := filepath.Join(parent, strings.TrimSpace(name))
	if exists(p) {
		return "", errors.New("something with that name already exists here")
	}
	if err := os.Mkdir(p, 0o755); err != nil {
		return "", friendlyErr(err)
	}
	return p, nil
}

func renameEntry(path, newName string) (string, error) {
	if err := validName(newName); err != nil {
		return "", err
	}
	np := filepath.Join(filepath.Dir(path), strings.TrimSpace(newName))
	if !samePath(np, path) && exists(np) {
		return "", errors.New("something with that name already exists here")
	}
	if np == path {
		return path, nil
	}
	if err := os.Rename(path, np); err != nil {
		return "", friendlyErr(err)
	}
	return np, nil
}

// ---------- copy / move ----------

func copyFile(src, dst string, st fs.FileInfo) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	return os.Chtimes(dst, st.ModTime(), st.ModTime())
}

// copyTree copies a file or folder and reports every (source, copy) pair so tags can follow.
func copyTree(src, dst string, pairs *[]Pair) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if st.Mode()&fs.ModeSymlink != 0 {
		if st, err = os.Stat(src); err != nil {
			return err
		}
	}
	if !st.IsDir() {
		if err := copyFile(src, dst, st); err != nil {
			return err
		}
		*pairs = append(*pairs, Pair{src, dst})
		return nil
	}
	if err := os.Mkdir(dst, 0o755); err != nil {
		return err
	}
	*pairs = append(*pairs, Pair{src, dst})
	des, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, d := range des {
		if err := copyTree(filepath.Join(src, d.Name()), filepath.Join(dst, d.Name()), pairs); err != nil {
			return err
		}
	}
	return os.Chtimes(dst, st.ModTime(), st.ModTime())
}

type OpResult struct {
	Done   []Pair   `json:"done"`
	Errors []string `json:"errors,omitempty"`
}

func moveEntries(lib *Library, paths []string, destDir string) OpResult {
	var res OpResult
	for _, src := range paths {
		name := filepath.Base(src)
		if samePath(filepath.Dir(src), destDir) {
			continue // already there
		}
		if st, err := os.Stat(src); err == nil && st.IsDir() && underRoot(destDir, src) {
			res.Errors = append(res.Errors, fmt.Sprintf("can't move “%s” into itself", name))
			continue
		}
		dst := uniquePath(destDir, name)
		if err := os.Rename(src, dst); err != nil {
			// different drive (or locked): copy, then remove the original
			var pairs []Pair
			if cerr := copyTree(src, dst, &pairs); cerr != nil {
				_ = os.RemoveAll(dst)
				res.Errors = append(res.Errors, fmt.Sprintf("couldn't move “%s”: %v", name, friendlyErr(cerr)))
				continue
			}
			if rerr := os.RemoveAll(src); rerr != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("“%s” was copied, but the original couldn't be removed", name))
			}
		}
		lib.Relocate([]Pair{{src, dst}})
		res.Done = append(res.Done, Pair{src, dst})
	}
	return res
}

func copyEntries(lib *Library, paths []string, destDir string) OpResult {
	var res OpResult
	for _, src := range paths {
		name := filepath.Base(src)
		if st, err := os.Stat(src); err == nil && st.IsDir() && underRoot(destDir, src) {
			res.Errors = append(res.Errors, fmt.Sprintf("can't copy “%s” into itself", name))
			continue
		}
		dst := uniquePath(destDir, name)
		var pairs []Pair
		if err := copyTree(src, dst, &pairs); err != nil {
			_ = os.RemoveAll(dst)
			res.Errors = append(res.Errors, fmt.Sprintf("couldn't copy “%s”: %v", name, friendlyErr(err)))
			continue
		}
		lib.CopyMeta(pairs)
		res.Done = append(res.Done, Pair{src, dst})
	}
	return res
}

// ---------- delete (Recycle Bin) ----------

func trashPaths(dataDir string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	if runtime.GOOS != "windows" {
		dir := filepath.Join(dataDir, "trash", time.Now().Format("20060102-150405"))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		for _, p := range paths {
			if err := os.Rename(p, uniquePath(dir, filepath.Base(p))); err != nil {
				return err
			}
		}
		return nil
	}
	b, _ := json.Marshal(paths)
	req := filepath.Join(dataDir, "trash-"+randHex(4)+".json")
	if err := os.WriteFile(req, b, 0o600); err != nil {
		return err
	}
	defer os.Remove(req)
	script := `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = Get-Content -Raw -Encoding UTF8 -LiteralPath '` + strings.ReplaceAll(req, "'", "''") + `' | ConvertFrom-Json
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
}`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	hideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("couldn't move to the Recycle Bin: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// ---------- open / reveal ----------

func openPath(path string, reveal bool) error {
	var cmd *exec.Cmd
	st, _ := os.Stat(path)
	isDir := st != nil && st.IsDir()
	switch runtime.GOOS {
	case "windows":
		switch {
		case reveal && !isDir:
			cmd = exec.Command("explorer.exe", "/select,", path)
		case isDir:
			cmd = exec.Command("explorer.exe", path)
		default:
			cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", path)
		}
	case "darwin":
		if reveal {
			cmd = exec.Command("open", "-R", path)
		} else {
			cmd = exec.Command("open", path)
		}
	default:
		target := path
		if reveal && !isDir {
			target = filepath.Dir(path)
		}
		cmd = exec.Command("xdg-open", target)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
