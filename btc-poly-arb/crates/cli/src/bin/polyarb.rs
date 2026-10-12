//! polyarb — Polymarket x Binance BTC 5m UP-share latency arbitrage.
//!
//! Subcommands:
//!   run       full stack: feeds -> engine -> executor (+ dashboard)
//!   sim       synthetic world (lagging market maker), PnL + latency report
//!   bench     latency/throughput harness (TSC cycle clock)
//!   discover  live Gamma discovery of the current 5m market
//!   book      live Polymarket book snapshot for the active window
//!   doctor    live checks: wallet, L2 auth derivation, balance

use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use engine::config::AppConfig;
use tokio::sync::broadcast;

#[derive(Parser)]
#[command(name = "polyarb", version, about = "Polymarket x Binance 5m BTC arb — Rust, lock-free hot path")]
struct Cli {
    /// config file (TOML)
    #[arg(long, default_value = "config/default.toml")]
    config: String,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// run the live stack (paper by default)
    Run {
        /// paper | live
        #[arg(long, default_value = "paper")]
        mode: String,
        /// overrides
        #[arg(long)]
        size: Option<f64>,
        #[arg(long)]
        edge_c: Option<f64>,
        #[arg(long)]
        jump_c: Option<f64>,
        #[arg(long)]
        dashboard_port: Option<u16>,
        /// required for live mode
        #[arg(long)]
        i_understand_live_trading_risks: bool,
        /// pin the engine thread to this core
        #[arg(long)]
        core: Option<usize>,
    },
    /// simulate against a lagging market maker
    Sim {
        #[arg(long, default_value = "30")]
        windows: u32,
        /// MM reaction lag in ms (the edge; 0 = control experiment)
        #[arg(long, default_value = "300")]
        lag_ms: f64,
        /// compression factor (50 = 5 virtual minutes per 6 real seconds)
        #[arg(long, default_value = "50")]
        speed: f64,
        #[arg(long, default_value = "7")]
        seed: u64,
        /// per-trade size in shares
        #[arg(long)]
        size: Option<f64>,
        /// run without the dashboard
        #[arg(long)]
        headless: bool,
        #[arg(long, default_value = "8080")]
        dashboard_port: u16,
    },
    /// latency + throughput benchmark
    Bench {
        /// include the 2M-event threaded pipeline test (~30s)
        #[arg(long, default_value = "true")]
        threaded: bool,
    },
    /// discover the current 5-minute market from Gamma
    Discover {
        /// print raw JSON
        #[arg(long)]
        json: bool,
    },
    /// print the live Polymarket UP book
    Book {
        /// price levels to print per side
        #[arg(long, default_value = "10")]
        depth: usize,
    },
    /// live checks with your credentials (POLY_PK env)
    Doctor,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .compact()
        .init();
    hotcore::clock::init();

    let cfg_path = std::path::Path::new(&cli.config);
    let mut cfg = if cfg_path.exists() {
        AppConfig::load_toml(cfg_path)?
    } else {
        if cli.config != "config/default.toml" {
            anyhow::bail!("config file not found: {}", cli.config);
        }
        AppConfig::default()
    };

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        match cli.cmd {
            Cmd::Run { mode, size, edge_c, jump_c, dashboard_port, i_understand_live_trading_risks, core } => {
                run_live_stack(cfg, mode, size, edge_c, jump_c, dashboard_port, i_understand_live_trading_risks, core).await
            }
            Cmd::Sim { windows, lag_ms, speed, seed, size, headless, dashboard_port } => {
                run_sim_cmd(cfg, windows, lag_ms, speed, seed, size, !headless, dashboard_port).await
            }
            Cmd::Bench { threaded } => {
                let threaded = threaded && !std::env::var("SKIP_THREADED").is_ok();
                let r = sim::bench::run(threaded);
                r.print();
                Ok(())
            }
            Cmd::Discover { json } => discover(cfg, json).await,
            Cmd::Book { depth } => book(cfg, depth).await,
            Cmd::Doctor => doctor(cfg).await,
        }
    })
}

async fn run_live_stack(
    mut cfg: AppConfig,
    mode: String,
    size: Option<f64>,
    edge_c: Option<f64>,
    jump_c: Option<f64>,
    port: Option<u16>,
    confirmed: bool,
    core: Option<usize>,
) -> anyhow::Result<()> {
    if mode == "live" {
        cfg.mode = wire::MODE_LIVE;
        if !confirmed {
            anyhow::bail!(
                "live mode requires --i-understand-live-trading-risks\n\
                 paper mode is the default; POLY_PK must be set for live"
            );
        }
        if std::env::var("POLY_PK").map(|k| k.trim().is_empty()).unwrap_or(true) {
            anyhow::bail!("POLY_PK environment variable not set (private key, 0x-prefixed hex)");
        }
    } else {
        cfg.mode = wire::MODE_PAPER;
    }
    if let Some(s) = size {
        cfg.size_sh = s;
    }
    if let Some(e) = edge_c {
        cfg.strategy.edge_c = e;
    }
    if let Some(j) = jump_c {
        cfg.strategy.jump_c = j;
    }
    if let Some(p) = port {
        cfg.bind = format!("0.0.0.0:{}", p);
    }
    if let Some(c) = core {
        cfg.pin_core = Some(c);
    }

    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║  polyarb — Polymarket x Binance BTC 5m UP-share arb        ║");
    println!("║  mode: {:<52}║", format!("{:?} (defaults: 20c/5s jump, 60c gate, 10c edge)", mode));
    println!("╚════════════════════════════════════════════════════════════╝");
    println!("  NOT FINANCIAL ADVICE. Paper mode simulates fills; live mode");
    println!("  sends real orders on Polygon. Know your risk limits.\n");

    let shared = Arc::new(engine::EngineShared::new(cfg.clone()));
    let (frame_tx, _) = broadcast::channel::<Vec<u8>>(256);

    // CLOB client + creds (live mode)
    let clob_client = if cfg.mode == wire::MODE_LIVE {
        let pk = std::env::var("POLY_PK")?;
        let wallet = Arc::new(clob::Wallet::from_hex(&pk)?);
        let client = Arc::new(clob::ClobClient::new(cfg.clob_rest.clone(), wallet.clone())?);
        client.prewarm(2).await;
        match client.derive_api_creds(0).await {
            Ok(creds) => {
                println!("  L2 credentials derived for {}", wallet.address_hex());
                let _ = creds;
                Some(client)
            }
            Err(e) => anyhow::bail!("credential derivation failed: {e:#}"),
        }
    } else {
        None
    };

    // window manager + token watch
    let gamma = feeds::GammaClient::new(cfg.gamma_rest.clone());
    let (tokens_tx, tokens_rx) = tokio::sync::watch::channel(feeds::WindowTokens::default());
    tokio::spawn(engine::window::run_window_manager(
        cfg.clone(),
        gamma,
        shared.win_ring.clone(),
        tokens_tx,
    ));

    // feeds
    tokio::spawn(feeds::run_binance(cfg.binance_ws.clone(), shared.binance_ring.clone(), {
        let h = Arc::new(feeds::FeedHealth::default());
        h
    }));
    tokio::spawn(feeds::run_polymarket(
        cfg.pm_ws.clone(),
        cfg.clob_rest.clone(),
        tokens_rx,
        shared.pm_ring.clone(),
        Arc::new(feeds::FeedHealth::default()),
    ));

    // executor
    let exec_deps = engine::exec::ExecDeps {
        cfg: cfg.clone(),
        order_ring: shared.order_ring.clone(),
        ctl_ring: shared.ctl_ring.clone(),
        client: clob_client,
        ladder: None,
    };
    tokio::spawn(engine::exec::run_executor(exec_deps));

    // engine thread
    let engine_thread = engine::spawn_engine_thread(shared.clone());

    // telemetry + dashboard
    tokio::spawn(engine::telemetry::run_telemetry(
        shared.clone(),
        engine::telemetry::TelemetryOpts {
            tx: frame_tx.clone(),
            jsonl: Some(std::path::PathBuf::from(&cfg.jsonl_path)),
            equity_csv: Some("logs/equity.csv".into()),
        },
    ));
    server::start(shared.clone(), &cfg.bind, frame_tx).await?;

    // ctrl-c: kill switch then cancel all
    tokio::signal::ctrl_c().await?;
    println!("\nshutdown: kill switch engaged");
    shared.set_kill(true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let engine_shared = shared.clone();
    let _ = engine_thread.join();
    let _ = engine_shared;
    Ok(())
}

async fn run_sim_cmd(
    mut cfg: AppConfig,
    windows: u32,
    lag_ms: f64,
    speed: f64,
    seed: u64,
    size: Option<f64>,
    web: bool,
    port: u16,
) -> anyhow::Result<()> {
    cfg.mode = wire::MODE_SIM;
    if let Some(s) = size {
        cfg.size_sh = s;
    }
    let world = sim::world::WorldCfg {
        n_windows: windows,
        mm_lag_ms: lag_ms,
        speed,
        seed,
        ..Default::default()
    };
    // compress wall-clock thresholds: the sim runs `speed`x faster than the
    // real market, so "20c within 5 (virtual) seconds" is 20c within
    // 5/speed real seconds, and paper network latency compresses too.
    let sp = world.speed.max(0.1);
    cfg.strategy.jump_window_s /= sp;
    cfg.strategy.min_tau_s /= sp;
    cfg.cooldown_s /= sp;
    cfg.paper_latency_ms = ((cfg.paper_latency_ms as f64) / sp).round() as u64;
    // diffusion time-compression: sigma scales with sqrt(speed) so the
    // engine prices the compressed window consistently with the world's
    // process (sigma * sqrt(tau_real) == sigma_v * sqrt(tau_virtual))
    let k = sp.sqrt();
    cfg.sigma_fallback *= k;
    cfg.sigma_floor *= k;
    cfg.sigma_cap *= k;
    let shared = Arc::new(engine::EngineShared::new(cfg.clone()));
    let (frame_tx, _) = broadcast::channel::<Vec<u8>>(256);
    if web {
        cfg.bind = format!("0.0.0.0:{}", port);
        server::start(shared.clone(), &cfg.bind, frame_tx.clone()).await?;
    }
    tokio::spawn(engine::telemetry::run_telemetry(
        shared.clone(),
        engine::telemetry::TelemetryOpts {
            tx: frame_tx,
            jsonl: Some("logs/sim-events.jsonl".into()),
            equity_csv: Some("logs/sim-equity.csv".into()),
        },
    ));
    let engine_thread = engine::spawn_engine_thread(shared.clone());

    let dur_est = Duration::from_millis((world.n_windows as f64 * world.window_s * 1000.0 / world.speed) as u64 + 3_000);
    println!("simulating {} windows @ speed {}x (~{:.1}s) ...", windows, speed, dur_est.as_secs_f64());
    let report = sim::run_sim(cfg, world, shared.clone()).await;
    shared.set_kill(true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = engine_thread.join();

    println!("\n╔══════════ SIM REPORT ══════════╗");
    println!("║ windows settled : {:>12} ║", report.windows);
    println!("║ signals         : {:>12} ║", report.signals);
    println!("║ trades filled   : {:>12} ║", report.trades);
    println!("║ realized PnL    : {:>10.1}c ║", report.realized_c);
    println!("║ unrealized PnL  : {:>10.1}c ║", report.unrealized_c);
    println!("║ equity          : {:>10.1}c ║", report.equity_c);
    println!("╠══════════ LATENCY (ns) ════════╣");
    println!("║ tick->signal p50/p99: {:>6}/{:<6} ║", report.lat_p50_tick_to_signal_ns, report.lat_p99_tick_to_signal_ns);
    println!("║ ring hop     p50/p99: {:>6}/{:<6} ║", report.lat_p50_ring_ns, report.lat_p99_ring_ns);
    println!("╚════════════════════════════════╝");
    let out = serde_json::to_string_pretty(&serde_json::json!({
        "windows": report.windows, "signals": report.signals,
        "trades": report.trades, "realized_c": report.realized_c,
        "unrealized_c": report.unrealized_c, "equity_c": report.equity_c,
        "latency": { "tick_to_signal_p50_ns": report.lat_p50_tick_to_signal_ns,
                     "tick_to_signal_p99_ns": report.lat_p99_tick_to_signal_ns },
        "rejects": report.rejects,
    }))?;
    std::fs::create_dir_all("logs")?;
    std::fs::write("logs/sim-report.json", out)?;
    println!("\nreport: logs/sim-report.json | events: logs/sim-events.jsonl | equity: logs/sim-equity.csv");
    Ok(())
}

async fn discover(cfg: AppConfig, json: bool) -> anyhow::Result<()> {
    let gamma = feeds::GammaClient::new(cfg.gamma_rest.clone());
    let now_ms = hotcore::clock::init().unix_ms();
    for epoch in [feeds::current_window_epoch(now_ms), feeds::next_window_epoch(now_ms)] {
        match gamma.fetch_window(epoch, 0).await {
            Ok(d) => {
                if json {
                    println!("{}", serde_json::json!({
                        "slug": d.slug, "title": d.title,
                        "start_ms": d.start_ms, "end_ms": d.end_ms,
                        "accepting": d.accepting_orders,
                        "tick_c": d.ctx.tick_c, "min_size": d.ctx.min_size,
                        "neg_risk": d.ctx.neg_risk,
                        "condition": format!("0x{}", hex_str(&d.ctx.condition)),
                        "token_up": d.ctx.token_up.to_dec(),
                        "token_down": d.ctx.token_down.to_dec(),
                    }));
                } else {
                    println!("slug     : {}", d.slug);
                    println!("title    : {}", d.title);
                    println!("window   : {} -> {}  (tau {:.0}s)", d.start_ms, d.end_ms, (d.end_ms - now_ms) as f64 / 1000.0);
                    println!("accepting: {} | tick {}c | min {} | negRisk {}", d.accepting_orders, d.ctx.tick_c, d.ctx.min_size, d.ctx.neg_risk);
                    println!("token UP  : {}", d.ctx.token_up.to_dec());
                    println!("token DOWN: {}", d.ctx.token_down.to_dec());
                    println!();
                }
            }
            Err(e) => println!("{}: {}", feeds::window_slug(epoch), e),
        }
    }
    Ok(())
}

async fn book(cfg: AppConfig, depth: usize) -> anyhow::Result<()> {
    let gamma = feeds::GammaClient::new(cfg.gamma_rest.clone());
    let now_ms = hotcore::clock::init().unix_ms();
    let epoch = feeds::current_window_epoch(now_ms);
    let d = gamma.fetch_window(epoch, 0).await?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build()?;
    let url = format!("{}/book?token_id={}", cfg.clob_rest.trim_end_matches('/'), d.ctx.token_up.to_dec());
    let resp: serde_json::Value = client.get(&url).send().await?.json().await?;
    println!("market {} — UP token book", d.title);
    println!("tick {}c | min size {} | negRisk {}", d.ctx.tick_c, d.ctx.min_size, d.ctx.neg_risk);
    if let Some(asks) = resp.get("asks").and_then(|a| a.as_array()) {
        println!("\nASKS (best last):");
        for lv in asks.iter().take(depth) {
            println!("  {:>6} x {}", lv["price"], lv["size"]);
        }
    }
    if let Some(bids) = resp.get("bids").and_then(|a| a.as_array()) {
        println!("\nBIDS:");
        for lv in bids.iter().rev().take(depth) {
            println!("  {:>6} x {}", lv["price"], lv["size"]);
        }
    }
    Ok(())
}

async fn doctor(cfg: AppConfig) -> anyhow::Result<()> {
    let pk = std::env::var("POLY_PK").unwrap_or_default();
    if pk.is_empty() {
        anyhow::bail!("POLY_PK not set — doctor needs your wallet key (read-only checks)");
    }
    let wallet = Arc::new(clob::Wallet::from_hex(&pk)?);
    println!("wallet      : {}", wallet.address_hex());
    let client = clob::ClobClient::new(cfg.clob_rest.clone(), wallet.clone())?;
    let t = client.time().await?;
    println!("clob /time  : {} (reachable)", t);
    client.prewarm(2).await;
    match client.derive_api_creds(0).await {
        Ok(creds) => {
            println!("L2 creds    : derived (key {}...)", &creds.api_key[..creds.api_key.len().min(12)]);
            match client.balance().await {
                Ok((balance, allowance)) => {
                    println!("USDC balance: {:.2}", balance);
                    println!("allowance   : {:.2} (must cover order size)", allowance);
                    if allowance < cfg.size_sh {
                        println!("  ⚠ allowance below configured trade size — approve the exchange in the Polymarket UI");
                    }
                }
                Err(e) => println!("balance     : error {e:#}"),
            }
        }
        Err(e) => println!("L2 creds    : FAILED {e:#}"),
    }
    Ok(())
}

fn hex_str(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
