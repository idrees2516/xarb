//! EIP-712 order signing for the Polymarket CLOB (CTF Exchange, Polygon 137).
//!
//! Faithful port of the official `clob-client` (TypeScript) signing scheme,
//! cross-checked field-by-field against the reference implementation:
//!   • L1 auth (GET /auth/derive-api-key): EIP-712 `ClobAuth` typed signature
//!     over a 3-field domain (name, version, chainId — NO verifyingContract)
//!   • Order signing: EIP-712 `Order` struct hash over the CTF Exchange domain
//!     (12 fields, ending `uint8 side, uint8 signatureType`)
//!   • L2 auth (private REST): HMAC-SHA256(api secret, ts+method+path+body)
//!     encoded as URL-safe base64 with padding
//!
//! The EIP-712 digest is keccak256(0x1901 ‖ domainSeparator ‖ structHash) with
//! every field ABI-encoded to exactly 32 bytes. No middleware libraries — the
//! hashing and ECDSA recovery are implemented directly against k256.

use anyhow::{anyhow, bail, Result};
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use sha3::Digest as _;
use sha3::Keccak256;

/// CTF Exchange (Polygon mainnet, chain 137).
pub const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
/// Neg-risk CTF Exchange (some markets).
pub const NEG_RISK_CTF_EXCHANGE: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
pub const CHAIN_ID: u64 = 137;

/// Fixed attestation signed for L1 derive-key (exact string from the official client).
const CLOB_AUTH_MESSAGE: &str = "This message attests that I control the given wallet";

// ── keccak + ABI primitives ─────────────────────────────────────────────────

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

fn keccak_concat(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn u256(x: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&x.to_be_bytes());
    out
}

/// Parse a u256 decimal string into 32 big-endian bytes.
pub fn u256_from_dec(s: &str) -> Result<[u8; 32]> {
    let mut bytes = [0u8; 32];
    if s.is_empty() {
        bail!("empty u256 string");
    }
    for ch in s.bytes() {
        if !ch.is_ascii_digit() {
            bail!("non-digit in u256 string: {s}");
        }
        let mut carry = (ch - b'0') as u16;
        for b in bytes.iter_mut().rev() {
            let v = (*b as u16) * 10 + carry;
            *b = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            bail!("u256 overflow: {s}");
        }
    }
    Ok(bytes)
}

/// 20-byte address → left-padded to 32 bytes (ABI `address`).
fn pad_addr(a: [u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&a);
    out
}

/// 20-byte address from a hex string (0x optional, EIP-55 checksum ignored).
pub fn addr_from_hex(s: &str) -> Result<[u8; 20]> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    let v = hex::decode(h).map_err(|e| anyhow!("bad address hex: {e}"))?;
    if v.len() != 20 {
        bail!("address must be 20 bytes");
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&v);
    Ok(out)
}

pub fn addr_to_hex(a: &[u8; 20]) -> String {
    hex::encode(a)
}

/// EIP-712 domain separator for `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`.
pub fn domain_separator(name: &str, version: &str, chain_id: u64, verifying: &[u8; 20]) -> [u8; 32] {
    let type_hash = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let name_h = keccak256(name.as_bytes());
    let ver_h = keccak256(version.as_bytes());
    keccak_concat(&[
        &type_hash,
        &name_h,
        &ver_h,
        &u256(chain_id as u128),
        &pad_addr(*verifying),
    ])
}

fn eip712_digest(domain_sep: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(66);
    buf.push(0x19);
    buf.push(0x01);
    buf.extend_from_slice(domain_sep);
    buf.extend_from_slice(struct_hash);
    keccak256(&buf)
}

// ── ECDSA sign + recover (Ethereum low-s, v = 27|28) ────────────────────────

/// Sign a 32-byte digest; returns 65 bytes r‖s‖v with v ∈ {27, 28} (EIP-2 low-s).
pub fn sign_digest(sk: &SigningKey, digest: &[u8; 32]) -> Result<[u8; 65]> {
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    let sig: Signature = sk
        .sign_prehash(digest)
        .map_err(|e| anyhow!("ecdsa sign: {e}"))?;
    // EIP-2: normalize to low-s
    let sig = sig.normalize_s().unwrap_or(sig);
    let vk = VerifyingKey::from(sk);

    // recovery id: 0/1 flips with y-parity — pick the one recovering our key
    let mut out = [0u8; 65];
    out[64] = 27; // default if recovery fails (never expected)
    let mut matched = false;
    for is_y_odd in [false, true] {
        let rid = RecoveryId::new(is_y_odd, false);
        if let Ok(candidate) = VerifyingKey::recover_from_prehash(digest, &sig, rid) {
            if candidate == vk {
                out[64] = if is_y_odd { 28 } else { 27 };
                matched = true;
                break;
            }
        }
    }
    if !matched {
        bail!("ecdsa recovery failed to match verifying key");
    }
    out[..64].copy_from_slice(&sig.to_bytes());
    Ok(out)
}

/// Ethereum address of a signing key: keccak256(pubkey)[12..].
pub fn address_of(sk: &SigningKey) -> [u8; 20] {
    let vk = VerifyingKey::from(sk);
    let pt = vk.to_encoded_point(false);
    let raw = pt.as_bytes();
    let hash = keccak256(&raw[1..65]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

// ── ClobAuth (L1): derive api key ───────────────────────────────────────────

/// EIP-712 signature for `ClobAuth(address address,string timestamp,uint256 nonce,string message)`
/// over domain `ClobAuthDomain/1` chain 137 — the domain has ONLY (name,
/// version, chainId), no verifyingContract (matches the official client).
/// Used by GET /auth/derive-api-key.
pub fn clob_auth_signature(sk: &SigningKey, timestamp_sec: u64, nonce: u64) -> Result<[u8; 65]> {
    // EIP712Domain(string name,string version,uint256 chainId)
    let domain_type = keccak256(b"EIP712Domain(string name,string version,uint256 chainId)");
    let domain = keccak_concat(&[
        &domain_type,
        &keccak256(b"ClobAuthDomain"),
        &keccak256(b"1"),
        &u256(CHAIN_ID as u128),
    ]);
    let type_hash =
        keccak256(b"ClobAuth(address address,string timestamp,uint256 nonce,string message)");
    let ts_bytes = format!("{timestamp_sec}");
    let struct_hash = keccak_concat(&[
        &type_hash,
        &pad_addr(address_of(sk)),
        &keccak256(ts_bytes.as_bytes()),
        &u256(nonce as u128),
        &keccak256(CLOB_AUTH_MESSAGE.as_bytes()),
    ]);
    let digest = eip712_digest(&domain, &struct_hash);
    sign_digest(sk, &digest)
}

// ── Order (EIP-712 over CTF Exchange) ───────────────────────────────────────

/// Order parameters, raw integer form (all u256, side 0=BUY 1=SELL).
#[derive(Debug, Clone)]
pub struct RawOrder {
    pub salt: u128,
    pub maker: [u8; 20],
    pub signer: [u8; 20],
    pub taker: [u8; 20],
    pub token_id: [u8; 32],
    pub maker_amount: u128,
    pub taker_amount: u128,
    pub expiration: u128,
    pub nonce: u128,
    pub fee_rate_bps: u128,
    /// 0 = BUY, 1 = SELL
    pub side: u8,
    /// 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE
    pub signature_type: u8,
}

impl RawOrder {
    /// EIP-712 struct hash — 12 fields, exactly matching the exchange contract:
    /// `Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)`
    pub fn struct_hash(&self) -> [u8; 32] {
        let type_hash = keccak256(
            b"Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)",
        );
        keccak_concat(&[
            &type_hash,
            &u256(self.salt),
            &pad_addr(self.maker),
            &pad_addr(self.signer),
            &pad_addr(self.taker),
            &self.token_id,
            &u256(self.maker_amount),
            &u256(self.taker_amount),
            &u256(self.expiration),
            &u256(self.nonce),
            &u256(self.fee_rate_bps),
            &u256(self.side as u128),
            &u256(self.signature_type as u128),
        ])
    }

    /// EIP-712 digest over the CTF Exchange domain.
    pub fn digest(&self) -> [u8; 32] {
        let domain = domain_separator("Polymarket CTF Exchange", "1", CHAIN_ID, &addr_from_hex(CTF_EXCHANGE).unwrap());
        eip712_digest(&domain, &self.struct_hash())
    }

    /// Sign and produce the CLOB POST /order JSON body (official client shape):
    /// `{"deferExec":false,"order":{…},"owner":<api key>,"orderType":<GTC|FOK|FAK>}`.
    /// Salt is a JSON number (kept < 2^53); big uints are decimal strings;
    /// `side` and `signatureType` mirror the REST enum encodings.
    pub fn signed_body(
        &self,
        sk: &SigningKey,
        neg_risk: bool,
        owner_api_key: &str,
        order_type: &str,
    ) -> Result<String> {
        // NEG_RISK markets sign over the neg-risk exchange contract.
        let digest = if neg_risk {
            let domain = domain_separator(
                "Polymarket CTF Exchange",
                "1",
                CHAIN_ID,
                &addr_from_hex(NEG_RISK_CTF_EXCHANGE).unwrap(),
            );
            eip712_digest(&domain, &self.struct_hash())
        } else {
            self.digest()
        };
        let sig = sign_digest(sk, &digest)?;
        let json = format!(
            r#"{{"deferExec":false,"order":{{"salt":{},"maker":"0x{}","signer":"0x{}","taker":"0x{}","tokenId":"{}","makerAmount":"{}","takerAmount":"{}","side":"{}","expiration":"{}","nonce":"{}","feeRateBps":"{}","signatureType":{},"signature":"0x{}"}},"owner":"{}","orderType":"{}"}}"#,
            self.salt,
            hex::encode(self.maker),
            hex::encode(self.signer),
            hex::encode(self.taker),
            u256_to_dec(&self.token_id),
            self.maker_amount,
            self.taker_amount,
            if self.side == 0 { "BUY" } else { "SELL" },
            self.expiration,
            self.nonce,
            self.fee_rate_bps,
            self.signature_type,
            hex::encode(sig),
            owner_api_key,
            order_type,
        );
        Ok(json)
    }
}

fn u256_to_dec(b: &[u8; 32]) -> String {
    // decimal rendering via repeated division by 10 on 32-byte BE
    let mut digits: Vec<u8> = Vec::new();
    let mut v = *b;
    loop {
        if v.iter().all(|&x| x == 0) {
            break;
        }
        let mut rem: u32 = 0;
        for byte in v.iter_mut() {
            let cur = rem * 256 + *byte as u32;
            *byte = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    if digits.is_empty() {
        return "0".to_string();
    }
    digits.reverse();
    String::from_utf8(digits).unwrap()
}

// ── helpers for building BUY orders ─────────────────────────────────────────

/// Build a marketable BUY order for `size` shares at `price` (dollars) on a
/// market with the given tick grid and taker fee. Collateral is 6-decimal
/// USDC; shares are 6-decimal units. BUY semantics: makerAmount = collateral,
/// takerAmount = shares. The price is rounded UP to the tick grid so the order
/// stays marketable; size is floored to 2 decimals (share lot grid).
pub fn build_buy_order(
    token_id_dec: &str,
    price_dollars: f64,
    size_shares: f64,
    maker: [u8; 20],
    tick_size: f64,
    fee_rate_bps: u64,
) -> Result<RawOrder> {
    let tick = if tick_size.is_finite() && tick_size > 0.0 && tick_size <= 0.1 {
        tick_size
    } else {
        0.01 // observed grid on the 5-minute BTC series
    };
    if !(tick..=1.0).contains(&price_dollars) {
        bail!("price out of range: {price_dollars}");
    }
    // ceil to the tick grid with a tolerance that absorbs f64 representation
    // noise when the price is already on the grid (0.56/0.01 = 56.000000000000005)
    let ratio = price_dollars / tick;
    let steps = (ratio - 1e-6).ceil().max(1.0);
    if steps > 999.0 {
        bail!("price out of range: {price_dollars}");
    }
    let price = (steps * tick * 1e9).round() / 1e9;
    if !(tick..=0.99).contains(&price) {
        bail!("price out of range: {price}");
    }
    let shares = (size_shares * 100.0).floor() / 100.0; // 2 decimals, down
    if shares < 5.0 {
        bail!("size below 5-share minimum: {shares}");
    }
    let taker = [0u8; 20];
    let token = u256_from_dec(token_id_dec)?;
    let share_raw = (shares * 1e6).round() as u128;
    let collateral = ((share_raw as f64) * price).round() as u128;
    // JSON-safe unique salt (< 2^53, mirroring the official client's
    // Math.round(Math.random() * Date.now()))
    let salt: u128 = {
        use rand::RngCore;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let r = (rand::thread_rng().next_u32() % 1000) as u64;
        (now_ms.wrapping_mul(1000).wrapping_add(r)) as u128
    };
    Ok(RawOrder {
        salt,
        maker,
        signer: maker,
        taker,
        token_id: token,
        maker_amount: collateral,
        taker_amount: share_raw,
        expiration: 0,
        nonce: 0,
        fee_rate_bps: fee_rate_bps as u128,
        side: 0,
        signature_type: 0, // EOA
    })
}

// ── L2 HMAC headers ─────────────────────────────────────────────────────────

/// L2 auth headers. POLY_SIGNATURE = HMAC-SHA256(base64-decoded secret,
/// ts‖method‖path‖body) encoded as URL-safe base64 WITH padding ('=' kept,
/// '+'→'-' and '/'→'_'), exactly like the official client.
pub fn l2_headers(
    creds: &Creds,
    address_hex: &str,
    method: &str,
    path: &str,
    body: &str,
    ts_sec: u64,
) -> Vec<(String, String)> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let secret_raw = base64_decode(&creds.secret).unwrap_or_default();
    let message = format!("{ts_sec}{method}{path}{body}");
    let mut mac = HmacSha256::new_from_slice(&secret_raw).unwrap_or_else(|_| unreachable!());
    mac.update(message.as_bytes());
    let sig = base64_urlsafe_encode(&mac.finalize().into_bytes());

    vec![
        ("POLY_ADDRESS".into(), address_hex.into()),
        ("POLY_SIGNATURE".into(), sig),
        ("POLY_TIMESTAMP".into(), format!("{ts_sec}")),
        ("POLY_API_KEY".into(), creds.api_key.clone()),
        ("POLY_PASSPHRASE".into(), creds.passphrase.clone()),
    ]
}

/// API credentials from GET /auth/derive-api-key.
#[derive(Debug, Clone)]
pub struct Creds {
    pub api_key: String,
    pub secret: String,
    pub passphrase: String,
}

/// Minimal base64 decode (standard alphabet; padding tolerated, base64url
/// input characters are sanitized first, matching the official client).
pub fn base64_decode(s: &str) -> Result<Vec<u8>> {
    let s: String = s
        .chars()
        .filter(|c| !c.eq(&'='))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            _ => c,
        })
        .collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => bail!("bad base64 char"),
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// URL-safe base64 encode (standard alphabet with '+'→'-' and '/'→'_',
/// '=' padding kept) — the encoding for the L2 HMAC signature.
pub fn base64_urlsafe_encode(data: &[u8]) -> String {
    // URL-safe alphabet: 62 = '-', 63 = '_' (padding '=' kept)
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(TBL[((n >> 18) & 63) as usize] as char);
        out.push(TBL[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TBL[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TBL[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(hexk: &str) -> SigningKey {
        let raw = hex::decode(hexk.strip_prefix("0x").unwrap_or(hexk)).unwrap();
        SigningKey::from_slice(&raw).unwrap()
    }

    #[test]
    fn known_address_derivation() {
        // private key = 1 → 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
        let sk = key("0000000000000000000000000000000000000000000000000000000000000001");
        assert_eq!(
            addr_to_hex(&address_of(&sk)).to_uppercase(),
            "7E5F4552091A69125D5DFCB7B8C2659029395BDF"
        );
    }

    #[test]
    fn u256_dec_roundtrip() {
        let dec = "9145918847504738641940976344046217412438338934";
        let b = u256_from_dec(dec).unwrap();
        assert_eq!(u256_to_dec(&b), dec);
        assert_eq!(u256_from_dec("0").unwrap(), [0u8; 32]);
        assert!(u256_from_dec("").is_err());
        assert!(u256_from_dec("12x").is_err());
    }

    #[test]
    fn sign_recovers_and_is_low_s() {
        let kb = keccak256(b"unit test key");
        let sk = SigningKey::from_slice(&kb).unwrap();
        let digest = keccak256(b"some message");
        let sig = sign_digest(&sk, &digest).unwrap();
        assert!(sig[64] == 27 || sig[64] == 28);
        // verify recovery: the (sig, v) pair must re-derive our public key
        let rid = RecoveryId::new(sig[64] == 28, false);
        let mut raw = [0u8; 64];
        raw.copy_from_slice(&sig[..64]);
        let s = Signature::from_slice(&raw).unwrap();
        let vk = VerifyingKey::recover_from_prehash(&digest, &s, rid).unwrap();
        assert_eq!(vk, VerifyingKey::from(&sk));
        // EIP-2 low-s: s must be below n/2 (top bit clear)
        assert_eq!(s.to_bytes()[0] & 0x80, 0);
    }

    #[test]
    fn order_digest_is_deterministic_and_sensitive() {
        let maker = addr_from_hex("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf").unwrap();
        let tok = u256_from_dec("123456789012345678901234567890").unwrap();
        let mut o = RawOrder {
            salt: 42,
            maker,
            signer: maker,
            taker: [0u8; 20],
            token_id: tok,
            maker_amount: 1_000_000,
            taker_amount: 1_700_000,
            expiration: 0,
            nonce: 0,
            fee_rate_bps: 0,
            side: 0,
            signature_type: 0,
        };
        let d1 = o.digest();
        let d2 = o.digest();
        assert_eq!(d1, d2);
        o.maker_amount += 1;
        assert_ne!(d1, o.digest());
        o.signature_type = 2;
        assert_ne!(d1, o.digest()); // signatureType is part of the typehash
        assert_eq!(d1.len(), 32);
    }

    #[test]
    fn buy_order_amounts() {
        let maker = [7u8; 20];
        let tok = "123456789012345678901234567890";
        let o = build_buy_order(tok, 0.56, 100.0, maker, 0.01, 1000).unwrap();
        // 100 shares @ $0.56 → collateral 56 USDC = 56e6 raw; shares 100e6
        assert_eq!(o.maker_amount, 56_000_000);
        assert_eq!(o.taker_amount, 100_000_000);
        assert_eq!(o.side, 0);
        assert_eq!(o.signature_type, 0);
        assert_eq!(o.fee_rate_bps, 1000); // market taker fee carried on the order
        assert!(o.salt < (1u128 << 53)); // JSON-number-safe salt
        // price is ceiled UP to the tick grid (marketable): 0.563 → 0.57
        let up = build_buy_order(tok, 0.563, 100.0, maker, 0.01, 0).unwrap();
        assert_eq!(up.maker_amount, 57_000_000);
        // finer grid: 0.5604 on a 0.001 tick → 0.561
        let fine = build_buy_order(tok, 0.5604, 100.0, maker, 0.001, 0).unwrap();
        assert_eq!(fine.maker_amount, 56_100_000);
        // size floors to 2 decimals: 100.999 → 100.99
        let sz = build_buy_order(tok, 0.56, 100.999, maker, 0.01, 0).unwrap();
        assert_eq!(sz.taker_amount, 100_990_000);
        assert!(build_buy_order(tok, 0.56, 4.9, maker, 0.01, 0).is_err());
        assert!(build_buy_order(tok, 0.0, 100.0, maker, 0.01, 0).is_err());
    }

    #[test]
    fn signed_body_payload_shape() {
        let kb = keccak256(b"payload shape test key");
        let sk = SigningKey::from_slice(&kb).unwrap();
        let maker = address_of(&sk);
        let order =
            build_buy_order("123456789012345678901234567890", 0.56, 100.0, maker, 0.01, 1000)
                .unwrap();
        let body = order
            .signed_body(&sk, false, "uuid-api-key", "FOK")
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["deferExec"], false);
        assert_eq!(v["owner"], "uuid-api-key");
        assert_eq!(v["orderType"], "FOK");
        let o = &v["order"];
        assert_eq!(o["salt"].as_u64().unwrap(), order.salt as u64); // JSON number
        assert_eq!(o["side"], "BUY"); // string in the REST payload
        assert_eq!(o["signatureType"], 0); // number in the REST payload
        assert_eq!(o["tokenId"].as_str().unwrap(), "123456789012345678901234567890");
        assert_eq!(o["makerAmount"].as_str().unwrap(), "56000000"); // string
        assert_eq!(o["takerAmount"].as_str().unwrap(), "100000000");
        assert_eq!(o["feeRateBps"].as_str().unwrap(), "1000");
        let sig = o["signature"].as_str().unwrap();
        assert!(sig.starts_with("0x") && sig.len() == 132); // 65 bytes hex
        assert_eq!(o["maker"].as_str().unwrap(), format!("0x{}", hex::encode(maker)));
        assert_eq!(o["taker"].as_str().unwrap(), "0x0000000000000000000000000000000000000000");
    }

    #[test]
    fn clob_auth_signature_is_deterministic() {
        let kb = keccak256(b"clob auth test key");
        let sk = SigningKey::from_slice(&kb).unwrap();
        let a = clob_auth_signature(&sk, 1_700_000_000, 0).unwrap();
        let b = clob_auth_signature(&sk, 1_700_000_000, 0).unwrap();
        assert_eq!(a, b); // RFC-6979 deterministic ECDSA
        assert!(a[64] == 27 || a[64] == 28);
    }

    #[test]
    fn base64_works() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGVsbG8h").unwrap(), b"hello!");
        assert_eq!(base64_decode("-_8=").unwrap(), b"\xfb\xff"); // base64url sanitized
        assert!(base64_decode("!!").is_err());
        // roundtrip through the url-safe encoder
        for n in 0..40 {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 % 256) as u8).collect();
            let enc = base64_urlsafe_encode(&data);
            assert_eq!(base64_decode(&enc).unwrap(), data);
        }
        assert_eq!(base64_urlsafe_encode(b"ab"), "YWI=");
        assert_eq!(base64_urlsafe_encode(&[0xfb, 0xff]), "-_8="); // '+'→'-', '/'→'_', '=' kept
    }
}
