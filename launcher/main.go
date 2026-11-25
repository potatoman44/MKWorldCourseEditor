// MK World Course Editor launcher: serves the editor page on this PC only and opens it in its own window.
package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"sync/atomic"
	"time"
)

//go:embed editor.html
var page []byte

// A fixed port keeps the page's origin the same between runs, so it remembers your folders.
const basePort = 47321

var lastPing atomic.Int64

// version of the embedded page: a newer exe replaces an older one that is still running
var version = func() string { h := sha256.Sum256(page); return hex.EncodeToString(h[:6]) }()

func main() {
	// already open? just bring up another window on the running copy
	for p := basePort; p < basePort+10; p++ {
		v, ok := running(p)
		if !ok {
			continue
		}
		if v == version {
			openWindow(p)
			return
		}
		// an older copy is still running: ask it to quit, then take its place
		c := http.Client{Timeout: time.Second}
		if r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/__quit", p)); err == nil {
			r.Body.Close()
		}
		for i := 0; i < 20; i++ {
			time.Sleep(150 * time.Millisecond)
			if _, still := running(p); !still {
				break
			}
		}
	}
	var ln net.Listener
	var port int
	for p := basePort; p < basePort+10; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			ln, port = l, p
			break
		}
	}
	if ln == nil {
		fail("Couldn't start: ports 47321-47330 are all in use.")
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(page)
	})
	mux.HandleFunc("/__mkwe", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "mkwe "+version) })
	mux.HandleFunc("/__quit", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
		go func() { time.Sleep(100 * time.Millisecond); os.Exit(0) }()
	})
	mux.HandleFunc("/__ping", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().Unix())
		w.Header().Set("X-Mkwe-Version", version)
		w.WriteHeader(204)
	})
	go http.Serve(ln, mux)
	lastPing.Store(time.Now().Unix())
	openWindow(port)
	// the page pings every few seconds; once every window has been closed for a while, quit
	for {
		time.Sleep(5 * time.Second)
		if time.Now().Unix()-lastPing.Load() > 40 {
			return
		}
	}
}

// running reports whether an editor answers on port p, and its version ("" for the first release)
func running(p int) (string, bool) {
	c := http.Client{Timeout: 400 * time.Millisecond}
	r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/__mkwe", p))
	if err != nil {
		return "", false
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	s := string(b)
	if !strings.HasPrefix(s, "mkwe") {
		return "", false
	}
	return strings.TrimSpace(strings.TrimPrefix(s, "mkwe")), true
}

func openWindow(port int) {
	// the version in the address makes Edge open a fresh window instead of reusing an older one
	url := fmt.Sprintf("http://127.0.0.1:%d/?v=%s", port, version)
	if b := findBrowser(); b != "" {
		// its own profile folder: a separate app window that remembers its settings
		prof := filepath.Join(dataDir(), "window")
		os.MkdirAll(prof, 0o755)
		// a profile that's already "set up": no welcome page, no sign-in or sync offers
		if _, err := os.Stat(filepath.Join(prof, "First Run")); err != nil {
			os.WriteFile(filepath.Join(prof, "First Run"), nil, 0o644)
		}
		cmd := exec.Command(b, "--app="+url, "--user-data-dir="+prof, "--no-first-run",
			"--no-default-browser-check", "--window-size=1500,920", "--disable-sync", "--no-service-autorun",
			"--disable-features=Translate,msImplicitSignin,msEdgeSyncConsent,msSignInPromo,msEdgeWelcomePage,msShowFirstRunExperience,EdgeSignInPromo",
			"--edge-skip-compat-layer-relaunch")
		hideConsole(cmd)
		if cmd.Start() == nil {
			return
		}
	}
	openDefault(url)
}

func findBrowser() string {
	if v := os.Getenv("MKWE_BROWSER"); v != "" {
		return v
	}
	var c []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if base := os.Getenv(env); base != "" {
			c = append(c, filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
		}
	}
	for _, p := range c {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func dataDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, "MKWorldCourseEditor")
	}
	d, _ := os.UserCacheDir()
	return filepath.Join(d, "MKWorldCourseEditor")
}
