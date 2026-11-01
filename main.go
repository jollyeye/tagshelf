package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"time"
)

type instance struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func (i instance) url() string { return fmt.Sprintf("http://127.0.0.1:%d/?t=%s", i.Port, i.Token) }

var noWindowMode bool

func main() {
	var dataDir string
	var background, quit bool
	var port int
	flag.StringVar(&dataDir, "data", "", "folder for the library, thumbnails and log (default: %AppData%\\TagShelf)")
	flag.BoolVar(&noWindowMode, "no-window", false, "don't open any window; print the address instead")
	flag.BoolVar(&background, "background", false, "start quietly in the background (catches downloads, opens no window)")
	flag.BoolVar(&quit, "quit", false, "close a running TagShelf and exit")
	flag.IntVar(&port, "port", 47821, "preferred local port")
	flag.Parse()

	if dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			base = "."
		}
		dataDir = filepath.Join(base, "TagShelf")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "cannot create data folder:", err)
		os.Exit(1)
	}
	if lf, err := os.OpenFile(filepath.Join(dataDir, "tagshelf.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(lf)
	} else {
		log.SetOutput(io.Discard)
	}

	// Already running? Open a window onto it (or close it).
	if inst, ok := readInstance(dataDir); ok && pingInstance(inst) {
		switch {
		case quit:
			quitInstance(inst)
		case background:
			// already running quietly - nothing to do
		case noWindowMode:
			fmt.Println(inst.url())
		default:
			openWindow(dataDir, inst.url())
		}
		return
	}
	if quit {
		return
	}

	lib, err := LoadLibrary(dataDir)
	if err != nil {
		log.Printf("cannot load library: %v", err)
		fmt.Fprintln(os.Stderr, "cannot load library:", err)
		os.Exit(1)
	}
	vecs.open(dataDir)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatalf("cannot listen: %v", err)
		}
	}
	actual := ln.Addr().(*net.TCPAddr).Port
	inst := instance{Port: actual, Token: randHex(16)}
	srv := newServer(lib, dataDir, inst.Token, actual)
	srv.bgFlag = background
	writeInstance(dataDir, inst)

	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("server stopped: %v", err)
			srv.Quit()
		}
	}()
	log.Printf("TagShelf %s listening on 127.0.0.1:%d", appVersion, actual)

	go lib.CheckMissing()
	go srv.watch.run()
	if !noWindowMode {
		go startTray(srv, inst.url())
	}

	switch {
	case noWindowMode:
		fmt.Println(inst.url())
	case background:
		log.Printf("running in the background")
	default:
		openWindow(dataDir, inst.url())
		go watchdog(srv)
	}
	if background {
		go watchdog(srv)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	select {
	case <-srv.quit:
	case <-sig:
	}
	if err := lib.Flush(); err != nil {
		log.Printf("final save failed: %v", err)
	}
	if err := vecs.save(); err != nil {
		log.Printf("saving fingerprints failed: %v", err)
	}
	removeInstance(dataDir, inst)
	log.Printf("TagShelf stopped")
}

// watchdog quits the app once its window has gone, unless it is meant to keep running in the
// background (to catch downloads).  A reload sends a new ping within seconds.
func watchdog(s *Server) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-t.C:
			if s.backgroundMode() {
				continue
			}
			now := time.Now().UnixNano()
			last, bye := s.lastPing.Load(), s.byeAt.Load()
			if bye != 0 && last < bye && now-bye > int64(8*time.Second) {
				log.Printf("window closed")
				s.Quit()
				return
			}
			if now-last > int64(5*time.Minute) {
				log.Printf("no window for 5 minutes")
				s.Quit()
				return
			}
		}
	}
}

// ---------- single-instance bookkeeping ----------

func instancePath(dir string) string { return filepath.Join(dir, "instance.json") }

func readInstance(dir string) (instance, bool) {
	var i instance
	b, err := os.ReadFile(instancePath(dir))
	if err != nil || json.Unmarshal(b, &i) != nil || i.Port == 0 || i.Token == "" {
		return i, false
	}
	return i, true
}

func writeInstance(dir string, i instance) {
	b, _ := json.Marshal(i)
	_ = os.WriteFile(instancePath(dir), b, 0o600)
}

func removeInstance(dir string, mine instance) {
	if cur, ok := readInstance(dir); ok && cur.Token == mine.Token {
		_ = os.Remove(instancePath(dir))
	}
}

func pingInstance(i instance) bool {
	req, err := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/ping", i.Port), nil)
	if err != nil {
		return false
	}
	req.AddCookie(&http.Cookie{Name: "tagshelf", Value: i.Token})
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

func quitInstance(i instance) {
	req, err := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/quit", i.Port), nil)
	if err != nil {
		return
	}
	req.AddCookie(&http.Cookie{Name: "tagshelf", Value: i.Token})
	req.Header.Set("X-TagShelf", "1")
	c := http.Client{Timeout: 3 * time.Second}
	if resp, err := c.Do(req); err == nil {
		resp.Body.Close()
	}
}

// ---------- windows ----------

func findBrowser() string {
	if runtime.GOOS == "windows" {
		rels := []string{
			filepath.Join("Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join("Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		}
		for _, rel := range rels {
			for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
				if base := os.Getenv(env); base != "" {
					p := filepath.Join(base, rel)
					if _, err := os.Stat(p); err == nil {
						return p
					}
				}
			}
		}
		return ""
	}
	for _, n := range []string{"microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
}

func launchApp(profile, url string, extra ...string) bool {
	exe := findBrowser()
	if exe == "" {
		return false
	}
	args := append([]string{"--app=" + url, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check"}, extra...)
	cmd := exec.Command(exe, args...)
	if err := cmd.Start(); err != nil {
		log.Printf("could not start %s: %v", exe, err)
		return false
	}
	go cmd.Wait()
	return true
}

// openWindow shows the UI in its own app-style window (Edge/Chrome --app mode, no tabs or
// address bar). If no such browser exists it falls back to the default browser.
func openWindow(dataDir, url string) {
	if launchApp(filepath.Join(dataDir, "browser"), url, "--window-size=1500,920") {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("could not open a browser: %v", err)
		return
	}
	go cmd.Wait()
}

// openPopup shows the small "tag this download" window. It uses its own browser profile so
// that the requested window size is honoured even while the main window is open.
func openPopup(dataDir, url string) {
	if launchApp(filepath.Join(dataDir, "browser-popup"), url, "--window-size=640,860") {
		return
	}
	openWindow(dataDir, url)
}
