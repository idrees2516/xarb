//! Window lifecycle manager (tokio task).
//!
//! The 5-minute series slug is deterministic (`btc-updown-5m-<epoch>`), so
//! discovery is a single Gamma GET. This task:
//!
//! 1. at startup installs the current window immediately,
//! 2. re-checks every 2 s (heals discovery failures),
//! 3. installs the next window ~1 s after the current one closes (the
//!    engine has already settled positions by then),
//! 4. notifies the Polymarket feed task (watch channel) so it resubscribes
//!    its market socket to the new outcome tokens.

use std::sync::Arc;
use std::time::Duration;

use feeds::gamma::GammaClient;
use feeds::polymarket::WindowTokens;
use feeds::{current_window_epoch, next_window_epoch};
use hotcore::clock::Clock;
use hotcore::ring::SpscRing;
use wire::CtlEvent;

use crate::config::AppConfig;

pub async fn run_window_manager(
    cfg: AppConfig,
    gamma: GammaClient,
    win_ring: Arc<SpscRing<CtlEvent>>,
    tokens_tx: tokio::sync::watch::Sender<WindowTokens>,
) {
    let clock = Clock::global();
    let mut installed: Option<(i64, u32)> = None; // (end_ms, seq)
    let mut seq: u32 = 0;
    let mut backoff_ms = 250u64;
    loop {
        let now_ms = clock.unix_ms();
        let need_fetch = match installed {
            None => true,
            Some((end_ms, _)) => now_ms >= end_ms + 1_000, // rollover
        };
        if need_fetch {
            // try the current epoch first; fall back to the next one when
            // the current is finishing/nearly closed
            let candidates = [current_window_epoch(now_ms), next_window_epoch(now_ms)];
            for epoch in candidates {
                seq += 1;
                match gamma.fetch_window(epoch, seq).await {
                    Ok(d) => {
                        if d.accepting_orders {
                            let _ = win_ring.try_push(CtlEvent::InstallWindow(d.ctx));
                            let _ = tokens_tx.send(WindowTokens {
                                up: d.ctx.token_up.to_dec(),
                                down: d.ctx.token_down.to_dec(),
                                seq,
                            });
                            installed = Some((d.end_ms, seq));
                            tracing::info!(
                                target: "window",
                                slug = d.slug,
                                title = d.title,
                                end_ms = d.end_ms,
                                "window installed"
                            );
                            backoff_ms = 250;
                            break;
                        } else {
                            tracing::warn!(target: "window", slug = d.slug, "not accepting orders");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(target: "window", epoch, "discovery failed: {e:#}");
                    }
                }
            }
            if installed.is_none() {
                let wait = Duration::from_millis(backoff_ms.min(5_000));
                tokio::time::sleep(wait).await;
                backoff_ms *= 2;
                continue;
            }
        }
        let _ = &cfg;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
