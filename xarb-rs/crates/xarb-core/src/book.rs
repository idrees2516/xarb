//! Polymarket CLOB book ladder.
//!
//! Levels are stored in `BTreeMap`s keyed by price in tenth-milli dollars
//! (price × 10_000 as i64), giving O(log n) level updates and O(1) amortized
//! best-quote lookups without any intermediary layers.

use crate::types::Level;
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct Book {
    /// BUY side: price_milli → size (shares). Best bid = last key.
    bids: BTreeMap<i64, f64>,
    /// SELL side: price_milli → size (shares). Best ask = first key.
    asks: BTreeMap<i64, f64>,
    /// Last epoch-ms of a book-affecting event.
    last_book_at: u64,
}

const SCALE: f64 = 10_000.0;

fn key(price: f64) -> i64 {
    (price * SCALE).round() as i64
}

impl Book {
    pub fn clear(&mut self) {
        self.bids.clear();
        self.asks.clear();
        self.last_book_at = 0;
    }

    pub fn touch(&mut self, now_ms: u64) {
        self.last_book_at = now_ms;
    }

    /// Apply a level update (size ≤ 0 deletes).
    pub fn set_level(&mut self, is_bid: bool, price: f64, size: f64) {
        let side = if is_bid { &mut self.bids } else { &mut self.asks };
        if size <= 0.0 || !price.is_finite() {
            side.remove(&key(price));
        } else {
            side.insert(key(price), size);
        }
    }

    /// Replace the whole ladder from a snapshot.
    pub fn replace(&mut self, bids: &[(f64, f64)], asks: &[(f64, f64)]) {
        self.bids.clear();
        self.asks.clear();
        for (p, s) in bids {
            self.bids.insert(key(*p), *s);
        }
        for (p, s) in asks {
            self.asks.insert(key(*p), *s);
        }
    }

    /// Best ask (dollars) and size, or None.
    pub fn best_ask(&self) -> Option<Level> {
        self.asks.iter().next().map(|(k, s)| Level {
            p: *k as f64 / SCALE,
            s: *s,
        })
    }

    /// Best bid (dollars) and size, or None.
    pub fn best_bid(&self) -> Option<Level> {
        self.bids.iter().next_back().map(|(k, s)| Level {
            p: *k as f64 / SCALE,
            s: *s,
        })
    }

    /// Top-n ask ladder (price asc), prices converted to cents.
    pub fn asks_top(&self, n: usize) -> Vec<Level> {
        self.asks
            .iter()
            .take(n)
            .map(|(k, s)| Level { p: *k as f64 / SCALE * 100.0, s: *s })
            .collect()
    }

    /// Top-n bid ladder (price desc), prices converted to cents.
    pub fn bids_top(&self, n: usize) -> Vec<Level> {
        self.bids
            .iter()
            .rev()
            .take(n)
            .map(|(k, s)| Level { p: *k as f64 / SCALE * 100.0, s: *s })
            .collect()
    }

    /// Full ask ladder in dollars (price asc) for book-walking fills.
    pub fn ask_ladder_usd(&self) -> Vec<Level> {
        self.asks
            .iter()
            .map(|(k, s)| Level { p: *k as f64 / SCALE, s: *s })
            .collect()
    }

    /// Age of the book in ms (u64::MAX if never touched).
    pub fn age_ms(&self, now_ms: u64) -> u64 {
        if self.last_book_at == 0 {
            u64::MAX
        } else {
            now_ms.saturating_sub(self.last_book_at)
        }
    }

    pub fn is_empty(&self) -> bool {
        self.asks.is_empty() && self.bids.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn best_quotes_and_updates() {
        let mut b = Book::default();
        b.replace(&[(0.54, 100.0)], &[(0.56, 200.0), (0.57, 300.0)]);
        assert_eq!(b.best_ask().unwrap().p, 0.56);
        assert_eq!(b.best_bid().unwrap().p, 0.54);
        b.set_level(false, 0.56, 0.0); // delete best ask
        assert_eq!(b.best_ask().unwrap().p, 0.57);
        b.set_level(true, 0.58, 50.0); // bid crosses
        assert_eq!(b.best_bid().unwrap().p, 0.58);
        assert_eq!(b.asks_top(6).len(), 1);
        assert_eq!(b.ask_ladder_usd()[0].p, 0.57);
    }

    #[test]
    fn age_tracking() {
        let mut b = Book::default();
        assert_eq!(b.age_ms(1000), u64::MAX);
        b.touch(900);
        assert_eq!(b.age_ms(1000), 100);
    }
}
