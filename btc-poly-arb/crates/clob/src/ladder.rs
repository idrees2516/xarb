//! Pre-signed order ladder.
//!
//! The tweet's "buy in that same second" budget is dominated by ECDSA
//! (~60-100 µs). This module removes even that: the executor periodically
//! pre-signs BUY orders for a ladder of price levels, so at fire time it
//! picks the level matching (or just above) the intended limit and POSTs
//! instantly — zero hashing, zero signing on the critical path.
//!
//! Trade-off: salt, size and price are baked at pre-sign time, so ladder
//! entries are valid for exactly (size, price) pairs. Entries refresh on a
//! timer and on window changes; misses fall back to sign-on-fire.

use std::collections::HashMap;

use wire::U256;

use crate::order::{OrderBuilder, SignedOrder};
use crate::spec::SIDE_BUY;

/// One token's ladder: limit price (cents) -> signed FAK order.
pub struct TokenLadder {
    pub token: U256,
    pub entries: HashMap<i64, SignedOrder>,
    pub generated_at_ns: i64,
}

pub struct Ladder {
    pub levels: Vec<i64>,
    pub size_sh: f64,
    pub tick_c: i64,
    pub neg_risk: bool,
    pub refresh_ns: i64,
    ladders: HashMap<U256, TokenLadder>,
}

impl Ladder {
    /// `levels` in cents relative to nothing — absolute price levels the
    /// strategy may want (e.g. 40..=90 by 1c).
    pub fn new(levels: Vec<i64>, size_sh: f64, refresh_s: f64) -> Ladder {
        Ladder {
            levels,
            size_sh,
            tick_c: 1,
            neg_risk: false,
            refresh_ns: (refresh_s * 1e9) as i64,
            ladders: HashMap::new(),
        }
    }

    /// Regenerate the ladder for a token if stale.
    pub fn refresh(
        &mut self,
        builder: &mut OrderBuilder,
        token: &U256,
        order_type: &str,
        owner_api_key: &str,
        now_ns: i64,
    ) {
        let needs = match self.ladders.get(token) {
            Some(l) => now_ns.saturating_sub(l.generated_at_ns) > self.refresh_ns,
            None => true,
        };
        if !needs {
            return;
        }
        let mut entries = HashMap::with_capacity(self.levels.len());
        for &price_c in &self.levels {
            let o = builder.build(
                token,
                SIDE_BUY,
                price_c,
                self.size_sh,
                self.tick_c,
                self.neg_risk,
                order_type,
                owner_api_key,
            );
            entries.insert(price_c, o);
        }
        self.ladders.insert(
            *token,
            TokenLadder {
                token: *token,
                entries,
                generated_at_ns: now_ns,
            },
        );
    }

    /// Pick the pre-signed order for a limit price: exact level, or the
    /// nearest level <= limit (never more aggressive than intended).
    pub fn take(&mut self, token: &U256, limit_c: i64) -> Option<SignedOrder> {
        let l = self.ladders.get(token)?;
        let mut best: Option<(&i64, &SignedOrder)> = None;
        for (price, order) in l.entries.iter() {
            if *price <= limit_c {
                match best {
                    Some((bp, _)) if *bp >= *price => {}
                    _ => best = Some((price, order)),
                }
            }
        }
        best.map(|(_, o)| {
            // clone: the ladder stays valid for repeated fires until refresh
            SignedOrder {
                salt: o.salt,
                token_id: o.token_id,
                side: o.side,
                maker_amount: o.maker_amount,
                taker_amount: o.taker_amount,
                signature: o.signature,
                json_body: o.json_body.clone(),
            }
        })
    }

    pub fn entry_count(&self, token: &U256) -> usize {
        self.ladders.get(token).map(|l| l.entries.len()).unwrap_or(0)
    }

    /// Drop ladders for tokens not in `keep` (window rollover).
    pub fn retain_only(&mut self, keep: &[U256]) {
        self.ladders.retain(|k, _| keep.contains(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::Wallet;

    fn builder() -> OrderBuilder {
        let w = Wallet::from_hex("4646464646464646464646464646464646464646464646464646464646464646")
            .unwrap();
        OrderBuilder::new(w, 1234)
    }

    #[test]
    fn ladder_take_picks_safe_level() {
        let mut b = builder();
        let mut l = Ladder::new((50..=90).collect(), 50.0, 30.0);
        let token = U256::from_dec("123456789").unwrap();
        l.refresh(&mut b, &token, "FAK", "owner", 0);
        assert_eq!(l.entry_count(&token), 41);
        // take at limit 63 -> level 63 exactly
        let o = l.take(&token, 63).unwrap();
        let v: serde_json::Value = serde_json::from_str(&o.json_body).unwrap();
        assert_eq!(v["order"]["makerAmount"], "31500000"); // 50 * 0.63
        // take at 63.5c (rounded 64 not in ladder? 63.5 -> limit_c 64) -> level 64
        let o2 = l.take(&token, 64).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&o2.json_body).unwrap();
        assert_eq!(v2["order"]["makerAmount"], "32000000");
        // nothing above the top level
        assert!(l.take(&token, 49).is_none());
    }

    #[test]
    fn ladder_refresh_stale() {
        let mut b = builder();
        let mut l = Ladder::new(vec![55], 5.0, 1.0); // 1s refresh
        let token = U256::from_dec("99").unwrap();
        l.refresh(&mut b, &token, "FAK", "o", 0);
        let s1 = l.take(&token, 55).unwrap().json_body;
        // fresh within window: same order served
        let s2 = l.take(&token, 55).unwrap().json_body;
        assert_eq!(s1, s2);
        // after refresh window: new salts
        l.refresh(&mut b, &token, "FAK", "o", 2_000_000_000);
        let s3 = l.take(&token, 55).unwrap().json_body;
        assert_ne!(s1, s3);
    }
}
