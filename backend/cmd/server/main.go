// Command server runs the Share Anywhere backend.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpserver"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/logging"
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
func probe() int {
	addr := os.Getenv("SA_HTTP_ADDR")
	if addr == "" || addr[0] == ':' {
		addr = "127.0.0.1" + addr
		if addr == "127.0.0.1" {
			addr += ":8080"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/healthz", nil)
	if err != nil {
		return 1
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("invalid configuration:\n%w", err)
	}
	log := logging.New(os.Stdout, cfg.LogLevel)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var checks []httpserver.Check
	if cfg.DatabaseURL != "" {
		pool, err := db.Open(ctx, cfg.DatabaseURL)
		if err != nil {
			return err
		}
		defer pool.Close()
		checks = append(checks, httpserver.Check{Name: "database", Fn: pool.Ping})
	} else {
		log.Warn("DATABASE_URL not set; running without a database (development only)")
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpserver.NewHandler(httpserver.Options{Logger: log, Version: version, Checks: checks}),
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
