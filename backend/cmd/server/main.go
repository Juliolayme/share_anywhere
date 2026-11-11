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

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/juliolayme/share_anywhere/backend/internal/auth"
	"github.com/juliolayme/share_anywhere/backend/internal/devices"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/access"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clientip"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/clock"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/config"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/db"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/httpserver"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/logging"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/metrics"
	"github.com/juliolayme/share_anywhere/backend/internal/platform/ws"
	"github.com/juliolayme/share_anywhere/backend/internal/sharing"
	"github.com/juliolayme/share_anywhere/backend/internal/signaling"
	"github.com/juliolayme/share_anywhere/backend/internal/transfers"
	"github.com/juliolayme/share_anywhere/backend/internal/turncreds"
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

	clk := newClock(cfg)
	if cfg.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required (share sessions and device identities live in PostgreSQL)")
	}
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
	checks := []httpserver.Check{{Name: "database", Fn: pool.Ping}}

	a, err := newApp(cfg, pool, devices.NewPGStore(pool), clk, log, checks)
	if err != nil {
		return err
	}
	go a.devices.RunPurger(ctx, time.Hour)
	go a.sharing.Run(ctx, 5*time.Second)
	go a.auth.Run(ctx, 5*time.Minute)
	if cfg.MetricsAddr != "" {
		// Internal listener only (not routed through Caddy); aggregates, never per person.
		mmux := http.NewServeMux()
		mmux.Handle("GET /metrics", a.metrics.Handler())
		msrv := &http.Server{Addr: cfg.MetricsAddr, Handler: mmux, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := msrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("metrics listener failed", "error", err.Error())
			}
		}()
		defer func() { _ = msrv.Close() }()
	}

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
	tokens  *devices.Tokens
	auth    *auth.Service
	sharing *sharing.Service
	hub     *ws.Hub
	metrics *metrics.Registry
}

// newApp wires every module onto one router; the route-table test builds the server the same way (with a
// nil pool, since it never reaches a handler that queries).
func newApp(cfg config.Config, pool *pgxpool.Pool, store devices.Store, clk clock.Clock, log *slog.Logger, checks []httpserver.Check) (*app, error) {
	tokens, err := devices.NewTokens(cfg.TokenKeys, cfg.TokenActiveKID, clk)
	if err != nil {
		return nil, err
	}
	ips := clientip.New(cfg.TrustedProxies)
	deviceSvc := devices.NewService(store, tokens, devices.NewPoW(cfg.ServerSecret, cfg.PoWDifficulty, clk), clk, devices.ScaledLimits(clk, cfg.RateLimitMultiplier), log)
	hub := ws.NewHub(ws.Config{AllowedOrigins: cfg.AllowedOrigins, Clock: clk, IPs: ips, Log: log})
	deviceSvc.OnRevoke(hub.DisconnectDevice)

	mailer, memMail := newMailer(cfg, log)
	authSvc := auth.New(auth.Config{
		Pool: pool, Clock: clk, Devices: deviceSvc, Hasher: auth.NewHasher(auth.DefaultArgon2, 4), Mailer: mailer,
		PublicURL: cfg.PublicURL, Limits: auth.ScaledLimits(clk, cfg.RateLimitMultiplier), Log: log,
	})
	// acct and dl in access tokens come from the account layer; a revoked device loses its account session.
	deviceSvc.SetAccounts(authSvc)
	deviceSvc.OnRevoke(authSvc.DeviceRevoked)
	deviceHTTP := devices.NewHTTP(deviceSvc, ips, clk, cfg.CookieSecure)

	limits := sharing.ScaledLimits(clk, cfg.RateLimitMultiplier)
	protected := sharing.NewProtectedMode(clk, cfg.CodeGuessAlarmPerMin)
	reg := metrics.New()
	shareSvc := sharing.NewService(sharing.Config{
		Pool: pool, Clock: clk, Secret: cfg.ServerSecret, Notify: hub, Limits: limits,
		Protected: protected, PublicURL: cfg.PublicURL, Log: log, Metrics: reg,
	})
	signaling.Register(hub, shareSvc)
	lookup := func(ctx context.Context, id string) (string, string, error) {
		d, err := deviceSvc.Get(ctx, id)
		return d.DisplayName, d.Platform, err
	}
	turn := turncreds.New(turncreds.Config{
		Secret: cfg.TURNSecret, URIs: cfg.TURNURIs, Clock: clk, Auth: shareSvc,
		GuestLimit: limits.TurnGuest, AcctLimit: limits.TurnAccount, Log: log,
		IPLimit: limits.TurnIP, IPKey: func(r *http.Request) string { return clientip.Key(ips.FromRequest(r)) },
	})
	xfers := transfers.New(transfers.Config{Pool: pool, Clock: clk, Sessions: shareSvc, Notify: hub, Metrics: reg, ReportLimit: limits.TransferReport})
	modules := []func(*access.Router){
		deviceHTTP.Register,
		auth.NewHTTP(authSvc, ips, deviceHTTP).Register,
		hub.Register,
		sharing.NewHTTP(shareSvc, ips, lookup).Register,
		turn.Register,
		transfers.NewHTTP(xfers, log).Register,
	}
	modules = append(modules, testHooks(cfg, clk, shareSvc, protected, memMail)...)
	h, router := httpserver.New(httpserver.Options{
		Logger: log, Version: version, Checks: checks, Verifier: deviceSvc,
		ClientIP: ips.FromRequest, LogKey: cfg.ServerSecret,
		Modules: modules,
	})
	return &app{handler: h, router: router, devices: deviceSvc, tokens: tokens, auth: authSvc, sharing: shareSvc, hub: hub, metrics: reg}, nil
}

// newMailer picks the password-reset mail sink (SA_MAIL_SINK). The console sink logs links only in
// development; the memory sink exists only with SA_ENV=test and is read through the testhooks build.
func newMailer(cfg config.Config, log *slog.Logger) (auth.Mailer, *auth.MemoryMailer) {
	switch cfg.MailSink {
	case "smtp":
		return auth.SMTPMailer{Addr: cfg.SMTPAddr, From: cfg.MailFrom, Username: cfg.SMTPUsername, Password: cfg.SMTPPassword}, nil
	case "memory":
		m := auth.NewMemoryMailer()
		return m, m
	default:
		if cfg.Env == config.EnvProduction {
			log.Warn("SA_MAIL_SINK is console: password reset mail is not delivered in production")
		}
		return auth.ConsoleMailer{Log: log, ShowLinks: cfg.Env == config.EnvDevelopment}, nil
	}
}
