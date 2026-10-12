//! Tiny SVG chart helpers (no JS chart libraries — pure Rust strings).

/// Map a series into an SVG polyline path within (w, h), given [lo, hi].
pub fn spark_path(v: &[f64], w: f64, h: f64, lo: f64, hi: f64) -> String {
    if v.is_empty() {
        return String::new();
    }
    let (lo, hi) = if (hi - lo).abs() < f64::EPSILON {
        (lo - 0.5, hi + 0.5)
    } else {
        (lo, hi)
    };
    let n = v.len() as f64;
    let mut d = String::with_capacity(v.len() * 12);
    for (i, x) in v.iter().enumerate() {
        let px = i as f64 / (n - 1.0).max(1.0) * w;
        let norm = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
        let py = h - norm * h;
        if i == 0 {
            d.push_str(&format!("M{:.1},{:.1}", px, py));
        } else {
            d.push_str(&format!("L{:.1},{:.1}", px, py));
        }
    }
    d
}

/// Centered auto-scaled sparkline (for signed values like PnL).
pub fn spark_centered(v: &[f64], w: f64, h: f64) -> String {
    if v.is_empty() {
        return String::new();
    }
    let max_abs = v.iter().map(|x| x.abs()).fold(0.0f64, f64::max).max(1.0);
    spark_path(v, w, h, -max_abs, max_abs)
}
