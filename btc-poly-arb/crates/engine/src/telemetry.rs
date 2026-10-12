//! Telemetry pump: SeqLock reads -> WebSocket broadcast + JSONL/CSV logs.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use wire::{DashState, ORD_RING, SIG_RING};

use crate::runner::EngineShared;

pub struct TelemetryOpts {
    pub tx: broadcast::Sender<Vec<u8>>,
    pub jsonl: Option<PathBuf>,
    pub equity_csv: Option<PathBuf>,
}

pub async fn run_telemetry(shared: Arc<EngineShared>, opts: TelemetryOpts) {
    let mut jsonl = opts.jsonl.and_then(|p| {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
    });
    let mut csv = opts.equity_csv.and_then(|p| {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let fresh = !p.exists();
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).ok()?;
        if fresh {
            let _ = writeln!(f, "t_ms,equity_c,realized_c,unrealized_c,mark,fv,up_ask");
        }
        Some(f)
    });
    let mut last_sig_head: u32 = 0;
    let mut last_ord_head: u32 = 0;
    let hello = wire::codec::encode_hello("polyarb", env!("CARGO_PKG_VERSION"));
    let _ = opts.tx.send(hello);
    loop {
        let d: DashState = shared.dash_state();
        let bytes = wire::codec::encode_dash(&d);
        let _ = opts.tx.send(bytes);
        // log new signals/orders
        if jsonl.is_some() {
            let sig_head = d.sig_head.min(SIG_RING as u32);
            if sig_head > last_sig_head {
                for i in last_sig_head..sig_head {
                    let s = &d.sigs[i as usize];
                    let line = serde_json::json!({
                        "kind": "signal",
                        "wall_ms": d.wall_ms,
                        "seq": s.seq,
                        "dir": s.dir,
                        "fv": s.fv,
                        "ask": s.ask,
                        "edge": s.edge,
                        "jump": s.jump,
                    });
                    append(&mut jsonl, &line.to_string());
                }
                last_sig_head = sig_head;
            } else if sig_head < last_sig_head {
                last_sig_head = sig_head; // reset (restart)
            }
            let ord_head = d.ord_head.min(ORD_RING as u32);
            if ord_head > last_ord_head {
                for i in last_ord_head..ord_head {
                    let o = &d.ords[i as usize];
                    let line = serde_json::json!({
                        "kind": "order",
                        "wall_ms": d.wall_ms,
                        "seq": o.seq,
                        "dir": o.dir,
                        "limit_c": o.limit_c,
                        "sh": o.sh,
                        "status": o.status,
                        "fill_sh": o.fill_sh,
                        "avg_px_c": o.avg_px_c,
                    });
                    append(&mut jsonl, &line.to_string());
                }
                last_ord_head = ord_head;
            } else if ord_head < last_ord_head {
                last_ord_head = ord_head;
            }
        }
        if csv.is_some() {
            let line = format!(
                "{},{:.2},{:.2},{:.2},{},{},{}",
                d.wall_ms, d.equity_c, d.realized_c, d.unrealized_c, d.mark, d.fv, d.up_ask
            );
            if let Some(f) = csv.as_mut() {
                let _ = writeln!(f, "{}", line);
            }
        }
        let fps = shared.cfg.dash_fps.max(1);
        tokio::time::sleep(Duration::from_millis(1000 / fps as u64)).await;
    }
}

fn append(f: &mut Option<std::fs::File>, line: &str) {
    if let Some(f) = f.as_mut() {
        let _ = writeln!(f, "{}", line);
    }
}

