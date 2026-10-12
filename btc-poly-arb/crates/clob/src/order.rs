//! Order construction with CLOB-exact rounding and hand-rendered JSON.
//!
//! BUY (tick 0.01 => price 2dp, size 2dp, amount 4dp):
//!   raw_taker = round_down(size, 2)              (shares)
//!   raw_maker = raw_taker * price                (USDC)
//!   makerAmount = round(raw_maker * 1e6)
//!   takerAmount = round(raw_taker * 1e6)
//! For integer-cent prices and whole-share sizes this is exact integer math:
//!   takerAmount = shares * 1e6
//!   makerAmount = shares * price_c * 1e4
//!
//! POST /order body (py-clob-client `utilities.order_to_json`):
//!   {"order":{salt:"...",maker:"0x..",signer:"0x..",taker:"0x..",
//!     tokenId:"...",makerAmount:"...",takerAmount:"...",expiration:"...",
//!     nonce:"...",feeRateBps:"...",side:"BUY",signatureType:0,
//!     signature:"0x..."},"owner":"<apiKey>","orderType":"FAK","postOnly":false}

use wire::U256;

use crate::eip712::{domain_separator, order_digest, OrderValues};
use crate::signer::{to_hex, Wallet};
use crate::spec::*;

/// Fast, well-distributed PRNG for salts (xoroshiro128**).
pub struct SaltRng {
    s: [u64; 2],
}

impl SaltRng {
    pub fn new(seed: u64) -> Self {
        // splitmix64 to expand the seed
        let mut z = seed.wrapping_add(0x9E3779B97F4A7C15);
        let mut next = || {
            z = z.wrapping_add(0x9E3779B97F4A7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
            x ^ (x >> 31)
        };
        SaltRng { s: [next(), next()] }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let rotl = |x: u64, k: u32| x.rotate_left(k);
        let result = rotl(self.s[0].wrapping_mul(5), 24).wrapping_add(9);
        let (a, b) = (self.s[0], self.s[1]);
        let s1 = a ^ b;
        self.s[0] = rotl(a, 24) ^ s1 ^ (s1 << 16);
        self.s[1] = rotl(s1, 37);
        result
    }

    /// Full 256-bit salt from two draws (high limb zero: salts need entropy,
    /// not magnitude — py-order-utils uses random.randint-ish values).
    pub fn next_salt(&mut self) -> U256 {
        U256([self.next_u64(), self.next_u64(), 0, self.next_u64() >> 8])
    }
}

/// Fully signed order, ready to serialize.
pub struct SignedOrder {
    pub salt: U256,
    pub token_id: U256,
    pub side: u8,
    pub maker_amount: u128,
    pub taker_amount: u128,
    pub signature: [u8; 65],
    /// JSON body ready for POST /order (exact bytes signed by the L2 HMAC).
    pub json_body: String,
}

/// Reusable builder for one wallet. NOT Sync — each executor thread owns one.
pub struct OrderBuilder {
    wallet: Wallet,
    domain: [u8; 32],
    domain_neg: [u8; 32],
    rng: SaltRng,
    maker_hex: String,
    signer_hex: String,
}

fn round_down(x: f64, dp: u32) -> f64 {
    let m = 10f64.powi(dp as i32);
    (x * m).floor() / m
}

fn round_normal(x: f64, dp: u32) -> f64 {
    let m = 10f64.powi(dp as i32);
    (x * m).round() / m
}

fn to_token_decimals(x: f64) -> u128 {
    let f = 1e6 * x;
    f.round() as u128
}

impl OrderBuilder {
    pub fn new(wallet: Wallet, seed: u64) -> OrderBuilder {
        let exch: [u8; 20] = hex_to_20(EXCHANGE).unwrap();
        let exch_neg: [u8; 20] = hex_to_20(EXCHANGE_NEG_RISK).unwrap();
        OrderBuilder {
            maker_hex: wallet.address_hex(),
            signer_hex: wallet.address_hex(),
            domain: domain_separator(&exch),
            domain_neg: domain_separator(&exch_neg),
            rng: SaltRng::new(seed),
            wallet,
        }
    }

    pub fn wallet(&self) -> &Wallet {
        &self.wallet
    }

    /// Compute (maker_amount, taker_amount) per CLOB rounding rules.
    /// `price_c` in integer cents; `size` in shares.
    pub fn amounts(side: u8, price_c: i64, size_sh: f64, tick_c: i64) -> (u128, u128) {
        let price_dp = decimal_digits_of_tick(tick_c);
        let price = price_c as f64 / 100.0;
        let raw_price = round_normal(price, price_dp);
        let raw_taker = round_down(size_sh, 2);
        let raw_maker = raw_taker * raw_price;
        let amount_dp = price_dp + 2;
        // py-clob-client dance: bump to amount+4 then floor to amount
        let raw_maker = {
            let up = round_normal(raw_maker, amount_dp + 4);
            let floored = round_down(up, amount_dp);
            if (up - floored).abs() < 1e-12 { raw_maker } else { floored.max(raw_maker) }
        };
        if side == SIDE_BUY {
            (to_token_decimals(raw_maker), to_token_decimals(raw_taker))
        } else {
            (to_token_decimals(raw_taker), to_token_decimals(raw_maker))
        }
    }

    /// Build, sign, and render a BUY/SELL order. `limit_c` integer cents.
    pub fn build(
        &mut self,
        token_id: &U256,
        side: u8,
        limit_c: i64,
        size_sh: f64,
        tick_c: i64,
        neg_risk: bool,
        order_type: &str,
        owner_api_key: &str,
    ) -> SignedOrder {
        let salt = self.rng.next_salt();
        let (maker_amount, taker_amount) = Self::amounts(side, limit_c, size_sh, tick_c);
        let vals = OrderValues {
            salt,
            maker: &self.wallet.address,
            signer: &self.wallet.address,
            taker: &[0u8; 20],
            token_id,
            maker_amount,
            taker_amount,
            expiration: 0,
            nonce: 0,
            fee_rate_bps: 0,
            side,
            signature_type: SIG_EOA,
        };
        let domain = if neg_risk { &self.domain_neg } else { &self.domain };
        let digest = order_digest(domain, &vals);
        let signature = self.wallet.sign_digest_65(&digest);
        let sig_hex = format!("0x{}", to_hex(&signature));
        let json_body = render_order_json(
            salt,
            &self.maker_hex,
            &self.signer_hex,
            token_id,
            maker_amount,
            taker_amount,
            side,
            &sig_hex,
            order_type,
            owner_api_key,
        );
        SignedOrder {
            salt,
            token_id: *token_id,
            side,
            maker_amount,
            taker_amount,
            signature,
            json_body,
        }
    }
}

fn decimal_digits_of_tick(tick_c: i64) -> u32 {
    // tick 0.01 -> 2; 0.001 -> 3; 0.0001 -> 4
    match tick_c {
        10 => 1,
        1 => 2,
        _ if tick_c % 10 == 0 => 1,
        _ => (tick_c as f64).log10().abs().ceil() as u32,
    }
}

pub fn hex_to_20(s: &str) -> Option<[u8; 20]> {
    let s = s.trim_start_matches("0x");
    if s.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Render the POST /order JSON. Numbers as strings, side as word.
#[allow(clippy::too_many_arguments)]
fn render_order_json(
    salt: U256,
    maker_hex: &str,
    signer_hex: &str,
    token: &U256,
    maker_amount: u128,
    taker_amount: u128,
    side: u8,
    sig_hex: &str,
    order_type: &str,
    owner: &str,
) -> String {
    let side_word = if side == SIDE_BUY { "BUY" } else { "SELL" };
    let mut s = String::with_capacity(620);
    s.push_str(r#"{"order":{"salt":""#);
    s.push_str(&salt.to_dec());
    s.push_str(r#"","maker":""#);
    s.push_str(maker_hex);
    s.push_str(r#"","signer":""#);
    s.push_str(signer_hex);
    s.push_str(r#"","taker":"0x0000000000000000000000000000000000000000","tokenId":""#);
    s.push_str(&token.to_dec());
    s.push_str(r#"","makerAmount":""#);
    push_u128(&mut s, maker_amount);
    s.push_str(r#"","takerAmount":""#);
    push_u128(&mut s, taker_amount);
    s.push_str(r#"","expiration":"0","nonce":"0","feeRateBps":"0","side":""#);
    s.push_str(side_word);
    s.push_str(r#"","signatureType":0,"signature":""#);
    s.push_str(sig_hex);
    s.push_str(r#""},"owner":""#);
    s.push_str(owner);
    s.push_str(r#"","orderType":""#);
    s.push_str(order_type);
    s.push_str(r#"","postOnly":false}"#);
    s
}

fn push_u128(s: &mut String, v: u128) {
    // avoid fmt machinery on the hot path: manual digits
    let mut buf = [0u8; 40];
    let mut n = 0;
    let mut x = v;
    if x == 0 {
        s.push('0');
        return;
    }
    while x > 0 {
        buf[n] = b'0' + (x % 10) as u8;
        x /= 10;
        n += 1;
    }
    for i in (0..n).rev() {
        s.push(buf[i] as char);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet() -> Wallet {
        Wallet::from_hex("4646464646464646464646464646464646464646464646464646464646464646").unwrap()
    }


    #[test]
    fn buy_amounts_integer() {
        // 50 shares at 56c: maker = 28.00 USDC -> 28,000,000; taker 50 -> 50,000,000
        let (m, t) = OrderBuilder::amounts(SIDE_BUY, 56, 50.0, 1);
        assert_eq!(m, 28_000_000);
        assert_eq!(t, 50_000_000);
        // price/maker ratio == 0.56
        assert!((m as f64 / t as f64 - 0.56).abs() < 1e-12);
    }

    #[test]
    fn buy_amounts_tick_1m() {
        // tick 0.001 (tick_c = 0? no: 0.001 dollars = 0.1 cents) — Polymarket
        // ticks are 0.001/0.01/0.1: cents are 0.1/1/10. For tick_c=1 (0.01):
        let (m, t) = OrderBuilder::amounts(SIDE_BUY, 556, 5.0, 1);
        assert_eq!(t, 5_000_000);
        assert_eq!(m, 27_800_000); // 5 * 5.56
    }

    #[test]
    fn sell_amounts() {
        let (m, t) = OrderBuilder::amounts(SIDE_SELL, 56, 50.0, 1);
        assert_eq!(m, 50_000_000); // shares out
        assert_eq!(t, 28_000_000); // usdc in
    }

    #[test]
    fn fractional_size_rounds_down() {
        let (m, t) = OrderBuilder::amounts(SIDE_BUY, 56, 50.129, 1);
        assert_eq!(t, 50_120_000);
        assert!(m <= (50.13f64 * 0.56 * 1e6).round() as u128);
    }

    #[test]
    fn json_shape_matches_reference() {
        let mut b = OrderBuilder::new(wallet(), 7);
        let token = U256::from_dec("64221595004315031085680510369561676046136972168397533565696485641727857977847").unwrap();
        let o = b.build(&token, SIDE_BUY, 56, 50.0, 1, false, "FAK", "key-123");
        let v: serde_json::Value = serde_json::from_str(&o.json_body).unwrap();
        assert_eq!(v["orderType"], "FAK");
        assert_eq!(v["owner"], "key-123");
        assert_eq!(v["postOnly"], false);
        assert_eq!(v["order"]["side"], "BUY");
        assert_eq!(v["order"]["signatureType"], 0);
        assert_eq!(v["order"]["makerAmount"], "28000000");
        assert_eq!(v["order"]["takerAmount"], "50000000");
        assert_eq!(v["order"]["tokenId"], token.to_dec());
        assert_eq!(v["order"]["maker"], b.wallet().address_hex());
        assert_eq!(v["order"]["taker"], "0x0000000000000000000000000000000000000000");
        assert_eq!(v["order"]["expiration"], "0");
        assert_eq!(v["order"]["nonce"], "0");
        let sig = v["order"]["signature"].as_str().unwrap();
        assert!(sig.starts_with("0x") && sig.len() == 132);
        // salt parses back
        let salt_dec = v["order"]["salt"].as_str().unwrap();
        assert_eq!(U256::from_dec(salt_dec).unwrap().to_dec(), salt_dec);
        // deterministic fields stable across builds except salt
        let o2 = b.build(&token, SIDE_BUY, 56, 50.0, 1, false, "FAK", "key-123");
        assert_ne!(
            v["order"]["salt"].as_str().unwrap(),
            serde_json::from_str::<serde_json::Value>(&o2.json_body).unwrap()["order"]["salt"]
                .as_str()
                .unwrap()
        );
    }

    #[test]
    fn salt_rng_distinct() {
        let mut r = SaltRng::new(42);
        let a = r.next_salt();
        let b = r.next_salt();
        assert_ne!(a, b);
        let mut r2 = SaltRng::new(42);
        assert_eq!(r2.next_salt(), a);
    }

    #[test]
    fn tick_digits() {
        assert_eq!(decimal_digits_of_tick(1), 2); // 0.01
        assert_eq!(decimal_digits_of_tick(10), 1); // 0.1
    }
}
