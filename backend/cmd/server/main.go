// Command server runs the Share Anywhere backend.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpserver"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/logging"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ws"
	"github.com/juliolayme/share_anywhere/backend/migrations"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local /healthz endpoint and exit 0 when healthy (for container health checks)")
	flag.Parse()
	if *healthcheck {
		os.Exit(probe())
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "server:", err)
		os.Exit(1)
	}
}

// probe calls the local health endpoint. Distroless images have no curl, so the binary checks itself.
// It always targets loopback; only the port is taken from SA_HTTP_ADDR, and it must be a valid number.
func probe() int {
	port, err := listenPort(os.Getenv("SA_HTTP_ADDR"))
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/healthz", port), nil) // #nosec G704 -- fixed loopback host, numeric port
	if err != nil {
		return 1
	}
	resp, err := http.DefaultClient.Do(req) // #nosec G704 -- fixed loopback host, numeric port
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// listenPort extracts the numeric port from an address such as ":8080" or "0.0.0.0:8080" (default 8080).
func listenPort(addr string) (int, error) {
	if addr == "" {
		return 8080, nil
	}
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, err
	}
	port, err := strconv.Atoi(p)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid port %q", p)
	}
	return port, nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("invalid configuration:\n%w", err)
	}
	log := logging.New(os.Stdout, cfg.LogLevel)
	for _, g := range cfg.Generated {
		log.Warn("using an ephemeral development value; set it to keep tokens valid across restarts", "setting", g)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	clk := clock.Real{}
	var checks []httpserver.Check
	var store devices.Store
	if cfg.DatabaseURL != "" {
		pool, err := db.Open(ctx, cfg.DatabaseURL)
		if err != nil {
			return err
		}
		defer pool.Close()
		if cfg.MigrateOnStart {
			applied, err := db.Migrate(ctx, pool, migrations.FS)
			if err != nil {
				return err
			}
			log.Info("migrations applied", "count", len(applied))
		}
		checks = append(checks, httpserver.Check{Name: "database", Fn: pool.Ping})
		store = devices.NewPGStore(pool)
	} else {
		if cfg.Env == config.EnvProduction {
			return errors.New("DATABASE_URL is required in production")
		}
		log.Warn("DATABASE_URL not set; device identities are kept in memory and lost on restart (development only)")
		store = devices.NewMemStore()
	}

	a, err := newApp(cfg, store, clk, log, checks)
	if err != nil {
		return err
	}
	go a.devices.RunPurger(ctx, time.Hour)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           a.handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("server listening", "addr", cfg.HTTPAddr, "env", cfg.Env, "version", version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	log.Info("shutting down", "timeout", cfg.ShutdownTimeout.String())
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	log.Info("stopped")
	return nil
}

type app struct {
	handler http.Handler
	router  *access.Router
	devices *devices.Service
}

// newApp wires every module onto one router; the route-table test builds the server the same way.
func newApp(cfg config.Config, store devices.Store, clk clock.Clock, log *slog.Logger, checks []httpserver.Check) (*app, error) {
	tokens, err := devices.NewTokens(cfg.TokenKeys, cfg.TokenActiveKID, clk)
	if err != nil {
		return nil, err
	}
	ips := clientip.New(cfg.TrustedProxies)
	deviceSvc := devices.NewService(store, tokens, devices.NewPoW(cfg.ServerSecret, cfg.PoWDifficulty, clk), clk, devices.ScaledLimits(clk, cfg.RateLimitMultiplier), log)
	hub := ws.NewHub(ws.Config{AllowedOrigins: cfg.AllowedOrigins, Clock: clk, IPs: ips, Log: log})
	h, router := httpserver.New(httpserver.Options{
		Logger: log, Version: version, Checks: checks, Verifier: deviceSvc,
		ClientIP: ips.FromRequest, LogKey: cfg.ServerSecret,
		Modules: []func(*access.Router){
			devices.NewHTTP(deviceSvc, ips, clk, cfg.CookieSecure).Register,
			hub.Register,
		},
	})
	return &app{handler: h, router: router, devices: deviceSvc}, nil
}
