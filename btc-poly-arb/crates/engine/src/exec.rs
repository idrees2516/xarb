//! Executor task: drains `OrderReq`s from the engine ring and executes.
//!
//! * **paper** — simulates a CLOB fill at the ask observed at signal time,
//!   after a configurable network/matching latency, with optional slippage.
//! * **live**  — builds + signs the EIP-712 order and POSTs it over a
//!   pre-warmed HTTP/2 connection; parses the FAK response into ack/fill.
//!
//! Both paths report through the control ring (`OrderAck` / `Fill` /
//! `OrderRejected`) plus a `LatencySample` for the order-build stage.

use std::sync::Arc;
use std::time::Duration;

use clob::order::OrderBuilder;
use clob::ClobClient;
use hotcore::clock::Clock;
use hotcore::ring::SpscRing;
use wire::{CtlEvent, OrderReq, ORD_REJ_MARKET, ORD_REJ_NET, ORD_REJ_TIMEOUT, ORD_REJ_UNKNOWN};

use crate::config::AppConfig;

pub struct ExecDeps {
    pub cfg: AppConfig,
    pub order_ring: Arc<SpscRing<OrderReq>>,
    pub ctl_ring: Arc<SpscRing<CtlEvent>>,
    /// live mode only
    pub client: Option<Arc<ClobClient>>,
    pub ladder: Option<Arc<tokio::sync::Mutex<clob::ladder::Ladder>>>,
}

pub async fn run_executor(deps: ExecDeps) {
    let clock = Clock::global();
    let cfg = deps.cfg.clone();
    let mut builder: Option<OrderBuilder> = None;
    if cfg.mode == wire::MODE_LIVE {
        if let Some(c) = deps.client.as_ref() {
            builder = Some(OrderBuilder::new(c.wallet().clone(), clock.mono_ns() as u64));
        }
    }
    let live = cfg.mode == wire::MODE_LIVE;
    loop {
        // drain
        let mut fired = false;
        while let Some(req) = deps.order_ring.try_pop() {
            fired = true;
            let t0 = clock.mono_ns();
            if live {
                execute_live(&cfg, &deps, builder.as_mut().unwrap(), req, &t0).await;
            } else {
                execute_paper(&cfg, &deps, req, &t0);
            }
        }
        if !fired {
            // idle: cooperative yield keeps this task off the CPU while
            // retaining sub-ms wakeups on the next signal
            tokio::time::sleep(Duration::from_millis(1)).await;
        } else {
            tokio::task::yield_now().await;
        }
    }
}

async fn execute_live(
    cfg: &AppConfig,
    deps: &ExecDeps,
    builder: &mut OrderBuilder,
    req: OrderReq,
    t0_ns: &i64,
) {
    let clock = Clock::global();
    let Some(client) = deps.client.as_ref() else {
        return;
    };
    if !client.has_creds().await {
        let _ = deps.ctl_ring.try_push(CtlEvent::OrderRejected {
            seq: req.seq,
            code: ORD_REJ_MARKET,
            ts_ns: clock.mono_ns(),
        });
        return;
    }
    // owner = derived api key (cached accessor, no network)
    let owner = client.api_key_hint().await;
    // order build (keccak hashStruct + ECDSA + JSON render) — measured
    let (built, cyc) = hotcore::clock::measure_cycles(|| {
        builder.build(
            &req.token,
            clob::spec::SIDE_BUY,
            req.limit_c,
            req.size_sh,
            req.tick_c.max(1),
            req.neg_risk,
            &cfg.order_type,
            &owner,
        )
    });
    let ns = clock.cycles_to_ns(cyc).max(0.0) as u64;
    let _ = deps
        .ctl_ring
        .try_push(CtlEvent::LatencySample { stage: 4, ns });
    let t1 = clock.mono_ns();
    match tokio::time::timeout(Duration::from_millis(3_000), client.post_order(&built.json_body)).await {
        Ok(Ok(resp)) => {
            let t2 = clock.mono_ns();
            tracing::info!(target: "exec", seq = req.seq, rtt_us = (t2 - t1) / 1000, status = ?resp.status, "order posted");
            if resp.success {
                let _ = deps.ctl_ring.try_push(CtlEvent::OrderAck {
                    seq: req.seq,
                    status: 1,
                    ts_ns: clock.mono_ns(),
                    order_id: resp
                        .order_id
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(0),
                });
                // FAK: matched amounts are in the response
                let taking = resp
                    .taking_amount
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0)
                    / 1e6;
                let making = resp
                    .making_amount
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0)
                    / 1e6;
                if taking > 0.0 || making > 0.0 {
                    // BUY: making = collateral spent, taking = shares received
                    let sh = taking;
                    let px_c = if sh > 0.0 { making / sh * 100.0 } else { 0.0 };
                    let _ = deps.ctl_ring.try_push(CtlEvent::Fill {
                        seq: req.seq,
                        dir: req.dir,
                        sh,
                        px_c,
                        ts_ns: clock.mono_ns(),
                        live: true,
                    });
                }
            } else {
                let _ = deps.ctl_ring.try_push(CtlEvent::OrderRejected {
                    seq: req.seq,
                    code: ORD_REJ_MARKET,
                    ts_ns: clock.mono_ns(),
                });
                tracing::warn!(target: "exec", err = ?resp.error_msg, "order rejected");
            }
        }
        Ok(Err(e)) => {
            let _ = deps.ctl_ring.try_push(CtlEvent::OrderRejected {
                seq: req.seq,
                code: ORD_REJ_NET,
                ts_ns: clock.mono_ns(),
            });
            tracing::warn!(target: "exec", err = format!("{e:#}"), "order post failed");
        }
        Err(_) => {
            let _ = deps.ctl_ring.try_push(CtlEvent::OrderRejected {
                seq: req.seq,
                code: ORD_REJ_TIMEOUT,
                ts_ns: clock.mono_ns(),
            });
        }
    }
    let _ = t0_ns;
}

fn execute_paper(cfg: &AppConfig, deps: &ExecDeps, req: OrderReq, t0_ns: &i64) {
    let clock = Clock::global();
    // measured "order build" in paper = decision + payload construction cost
    let (_, cyc) = hotcore::clock::measure_cycles(|| {
        let _ = (req.limit_c, req.size_sh, req.token.to_dec());
    });
    let ns = clock.cycles_to_ns(cyc).max(0.0) as u64;
    let _ = deps
        .ctl_ring
        .try_push(CtlEvent::LatencySample { stage: 4, ns });

    // network + matching latency model
    let latency = Duration::from_millis(cfg.paper_latency_ms);
    std::thread::sleep(latency);

    // fill model: we take the observed ask plus slippage, capped by limit
    let fill_px_c = (req.ask_at_signal_c + cfg.paper_slippage_c).min(req.limit_c);
    let fill_sh = req.size_sh.min(req.ask_sz_at_signal).max(0.0);
    let t = clock.mono_ns();
    if fill_sh <= 0.0 || fill_px_c <= 0 || fill_px_c > 99 {
        let _ = deps.ctl_ring.try_push(CtlEvent::OrderRejected {
            seq: req.seq,
            code: ORD_REJ_MARKET,
            ts_ns: t,
        });
        return;
    }
    let _ = deps.ctl_ring.try_push(CtlEvent::OrderAck {
        seq: req.seq,
        status: 1,
        ts_ns: t,
        order_id: 0,
    });
    // the ENGINE validates this against the live book: if the MM requoted
    // away during our latency window, the fill misses (adverse selection)
    let _ = deps.ctl_ring.try_push(CtlEvent::FillAttempt {
        seq: req.seq,
        dir: req.dir,
        sh: fill_sh,
        limit_c: fill_px_c,
        ts_ns: t,
    });
    let _ = t0_ns;
    // full round trip for the paper fire path (signal -> fill)
    let _ = t;
}
