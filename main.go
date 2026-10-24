package main

import (
	"log"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"linkdeck/internal/config"
	"linkdeck/internal/link"
	"linkdeck/internal/script"
	"linkdeck/internal/serial"
	"linkdeck/internal/stream"
	"linkdeck/internal/tcp"
)

// Greeter is callable from the frontend: `mygo generate` turns its methods
// into typed TypeScript functions in src/mygo.ts.
type Greeter struct{}

// Greet returns a greeting for name.
func (Greeter) Greet(name string) string {
	if name == "" {
		name = "stranger"
	}
	return "Hello, " + name + "! This message comes from Go."
}

// SystemInfo describes the machine the app runs on.
type SystemInfo struct {
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	GoVersion string `json:"goVersion"`
}

// Info returns information about the system.
func (Greeter) Info() SystemInfo {
	return SystemInfo{OS: runtime.GOOS, Arch: runtime.GOARCH, GoVersion: runtime.Version()}
}

// Tick is sent to the page every second.
var Tick = mygo.NewEvent[time.Time]("tick")

// Frames carries unmatched-frame batches (matcher-first path) to the UI.
// Payloads cross as base64 strings; see script.FrameDTO.
var Frames = mygo.NewEvent[[]script.FrameDTO]("frames")

// ScriptAPI is the bound scripting surface. Sessions (Engine.Load) stay
// Go-side until the UI grows a session surface; Run/RunFile cover the
// script-run panel.
type ScriptAPI struct {
	svc *script.ScriptService
}

// Run executes Lua source with a millisecond timeout.
func (a ScriptAPI) Run(src string, timeoutMs int) error {
	return a.svc.Run(src, timeoutMs)
}

// RunFile executes a script file with a millisecond timeout.
func (a ScriptAPI) RunFile(path string, timeoutMs int) error {
	return a.svc.RunFile(path, timeoutMs)
}

// ConfigAPI exposes presets and favorites to the UI.
type ConfigAPI struct{}

// Favorites returns persisted script-favorite paths.
func (ConfigAPI) Favorites() []string {
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; using defaults", err)
	}
	return cfg.Favorites
}

// SetFavorites persists script-favorite paths (atomic write).
func (ConfigAPI) SetFavorites(favs []string) error {
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; overwriting with defaults", err)
		cfg = config.DefaultConfig()
	}
	cfg.Favorites = favs
	return config.Save(cfg)
}

// Presets returns named channel presets.
func (ConfigAPI) Presets() map[string]config.Preset {
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; using defaults", err)
	}
	if cfg.Presets == nil {
		return map[string]config.Preset{}
	}
	return cfg.Presets
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; running on defaults", err)
	}
	_ = cfg

	serialSvc := serial.NewSerialService()
	tcpSvc := tcp.NewTcpService()
	engine := script.NewEngine(script.EngineOptions{
		Serial: link.NewSerialTransport(serialSvc),
		TCP:    link.NewTCPTransport(tcpSvc),
	})
	scriptAPI := ScriptAPI{svc: script.NewScriptService(engine)}

	mygo.Bind(Greeter{}, serialSvc, tcpSvc, scriptAPI, ConfigAPI{})

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "linkdeck",
			Width:           1280,
			Height:          800,
			MinWidth:        480,
			MinHeight:       360,
			BackgroundColor: "light-dark(#f6f7f9, #0f1115)", // the page's --bg in src/style.css
			// Opens where the user left it last time.
			StateKey: "main",
			// The frontend: devUrl during `mygo dev`, frontendDist
			// embedded by `mygo build` otherwise (see mygo.json).
			URL: "/",
		})
		mgr := stream.NewManager(engine.Pool(), func(b stream.Batch) {
			dtos := make([]script.FrameDTO, 0, len(b.Frames))
			for _, f := range b.Frames {
				dtos = append(dtos, f.ToDTO())
			}
			// Best effort: a closed window ends delivery; loops keep
			// running until their channels close.
			_ = Frames.Emit(win, dtos)
		})
		serialSvc.AttachStream(mgr)
		tcpSvc.AttachStream(mgr)
		go func() {
			for t := range time.Tick(time.Second) {
				if Tick.Emit(win, t) != nil {
					return // the window was closed
				}
			}
		}()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
