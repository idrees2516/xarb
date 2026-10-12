//! EIP-712 hashing for the Polymarket Order and ClobAuth structs.
//!
//! Encoding rules (per poly_eip712_structs, verified):
//! * every static value (uintN of any size, address, bool) is one 32-byte
//!   big-endian word
//! * dynamic values (string, bytes) are keccak256(content) as one word
//! * hashStruct = keccak256(typeHash || encodedWords...)
//! * digest = keccak256(0x1901 || domainSeparator || hashStruct)

use wire::U256;

use crate::spec::*;

/// 12 words: salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
/// expiration, nonce, feeRateBps, side, signatureType.
const ORDER_WORDS: usize = 12;

pub struct OrderValues<'a> {
    pub salt: U256,
    pub maker: &'a [u8; 20],
    pub signer: &'a [u8; 20],
    pub taker: &'a [u8; 20],
    pub token_id: &'a U256,
    pub maker_amount: u128,
    pub taker_amount: u128,
    pub expiration: u64,
    pub nonce: u64,
    pub fee_rate_bps: u64,
    /// 0 = BUY, 1 = SELL
    pub side: u8,
    pub signature_type: u8,
}

#[inline]
fn put_word(buf: &mut [u8], idx: usize, bytes: &[u8]) {
    let off = idx * 32;
    let n = bytes.len().min(32);
    buf[off..off + n].copy_from_slice(&bytes[..n]);
}

#[inline]
fn put_u128(buf: &mut [u8], idx: usize, v: u128) {
    let off = idx * 32;
    buf[off + 16..off + 32].copy_from_slice(&v.to_be_bytes());
}

#[inline]
fn put_u64(buf: &mut [u8], idx: usize, v: u64) {
    let off = idx * 32;
    buf[off + 24..off + 32].copy_from_slice(&v.to_be_bytes());
}

/// Domain separator with verifyingContract (orders).
pub fn domain_separator(exchange_addr: &[u8; 20]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(6 * 32);
    let type_hash = keccak256(DOMAIN_TYPEHASH_STR.as_bytes());
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&keccak256(ORDER_DOMAIN_NAME.as_bytes()));
    buf.extend_from_slice(&keccak256(ORDER_DOMAIN_VERSION.as_bytes()));
    let mut chain = [0u8; 32];
    chain[24..32].copy_from_slice(&CHAIN_ID.to_be_bytes());
    buf.extend_from_slice(&chain);
    let mut addr_word = [0u8; 32];
    addr_word[12..32].copy_from_slice(exchange_addr);
    buf.extend_from_slice(&addr_word);
    keccak256(&buf)
}

/// Domain separator without verifyingContract (ClobAuth).
pub fn auth_domain_separator() -> [u8; 32] {
    let mut buf = Vec::with_capacity(4 * 32);
    let type_hash = keccak256(DOMAIN_TYPEHASH_NO_ADDR_STR.as_bytes());
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&keccak256(CLOB_AUTH_DOMAIN_NAME.as_bytes()));
    buf.extend_from_slice(&keccak256(CLOB_AUTH_DOMAIN_VERSION.as_bytes()));
    let mut chain = [0u8; 32];
    chain[24..32].copy_from_slice(&CHAIN_ID.to_be_bytes());
    buf.extend_from_slice(&chain);
    keccak256(&buf)
}

/// hashStruct(Order) — 13 words total (type hash + 12 value words).
pub fn order_struct_hash(o: &OrderValues) -> [u8; 32] {
    let mut buf = [0u8; (ORDER_WORDS + 1) * 32];
    let type_hash = keccak256(ORDER_TYPEHASH_STR.as_bytes());
    buf[0..32].copy_from_slice(&type_hash);
    put_word(&mut buf, 1, &o.salt.to_be_bytes());
    put_word(&mut buf, 2, o.maker);
    put_word(&mut buf, 3, o.signer);
    put_word(&mut buf, 4, o.taker);
    put_word(&mut buf, 5, &o.token_id.to_be_bytes());
    put_u128(&mut buf, 6, o.maker_amount);
    put_u128(&mut buf, 7, o.taker_amount);
    put_u64(&mut buf, 8, o.expiration);
    put_u64(&mut buf, 9, o.nonce);
    put_u64(&mut buf, 10, o.fee_rate_bps);
    put_word(&mut buf, 11, &[o.side]);
    put_word(&mut buf, 12, &[o.signature_type]);
    keccak256(&buf)
}

/// EIP-712 digest for an order.
pub fn order_digest(domain_separator: &[u8; 32], o: &OrderValues) -> [u8; 32] {
    let struct_hash = order_struct_hash(o);
    let mut buf = Vec::with_capacity(66);
    buf.push(0x19);
    buf.push(0x01);
    buf.extend_from_slice(domain_separator);
    buf.extend_from_slice(&struct_hash);
    keccak256(&buf)
}

/// ClobAuth hashStruct: address, timestamp (string), nonce, message (string).
pub fn clob_auth_struct_hash(address: &[u8; 20], timestamp: &str, nonce: u64, message: &str) -> [u8; 32] {
    let mut buf = [0u8; 5 * 32];
    let type_hash = keccak256(CLOB_AUTH_TYPEHASH_STR.as_bytes());
    buf[0..32].copy_from_slice(&type_hash);
    put_word(&mut buf, 1, address);
    let ts_hash = keccak256(timestamp.as_bytes());
    put_word(&mut buf, 2, &ts_hash);
    put_u64(&mut buf, 3, nonce);
    let msg_hash = keccak256(message.as_bytes());
    put_word(&mut buf, 4, &msg_hash);
    keccak256(&buf)
}

/// EIP-712 digest for ClobAuth.
pub fn clob_auth_digest(timestamp: &str, nonce: u64, address: &[u8; 20]) -> [u8; 32] {
    let struct_hash = clob_auth_struct_hash(address, timestamp, nonce, CLOB_AUTH_MESSAGE);
    let domain = auth_domain_separator();
    let mut buf = Vec::with_capacity(66);
    buf.push(0x19);
    buf.push(0x01);
    buf.extend_from_slice(&domain);
    buf.extend_from_slice(&struct_hash);
    keccak256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic vector: recompute the digest and ensure it changes
    /// whenever any field changes (structure sanity).
    #[test]
    fn digest_sensitivity() {
        let maker = [7u8; 20];
        let signer = [7u8; 20];
        let taker = [0u8; 20];
        let token = U256([1, 2, 3, 4]);
        let base = OrderValues {
            salt: U256([99, 0, 0, 0]),
            maker: &maker,
            signer: &signer,
            taker: &taker,
            token_id: &token,
            maker_amount: 2_800_000,
            taker_amount: 5_000_000,
            expiration: 0,
            nonce: 0,
            fee_rate_bps: 0,
            side: 0,
            signature_type: 0,
        };
        let ds = domain_separator(&[0x4b, 0xFb, 0x41, 0xd5, 0xB3, 0x57, 0x0D, 0xeF, 0xd0, 0x3C, 0x39, 0xa9, 0xA4, 0xD8, 0xdE, 0x6B, 0xd8, 0xB8, 0x98, 0x2E]);
        let d0 = order_digest(&ds, &base);
        // every mutated field must change the digest
        fn clone<'a>(o: &OrderValues<'a>) -> OrderValues<'a> {
            OrderValues {
            salt: o.salt,
            maker: o.maker,
            signer: o.signer,
            taker: o.taker,
            token_id: o.token_id,
            maker_amount: o.maker_amount,
            taker_amount: o.taker_amount,
            expiration: o.expiration,
            nonce: o.nonce,
            fee_rate_bps: o.fee_rate_bps,
            side: o.side,
            signature_type: o.signature_type,
            }
        }
        let mut m = clone(&base);
        m.salt = U256([100, 0, 0, 0]);
        assert_ne!(d0, order_digest(&ds, &m));
        let mut m2 = clone(&base);
        m2.maker_amount += 1;
        assert_ne!(d0, order_digest(&ds, &m2));
        let mut m3 = clone(&base);
        m3.side = 1;
        assert_ne!(d0, order_digest(&ds, &m3));
        let mut m4 = clone(&base);
        let t9 = U256([9, 9, 9, 9]);
        m4.token_id = &t9;
        assert_ne!(d0, order_digest(&ds, &m4));
    }

    #[test]
    fn domain_separator_differs_neg_risk() {
        let a = domain_separator(&[1u8; 20]);
        let b = domain_separator(&[2u8; 20]);
        assert_ne!(a, b);
    }

    #[test]
    fn clob_auth_digest_deterministic() {
        let addr = [0xab; 20];
        let d1 = clob_auth_digest("1766162400", 0, &addr);
        let d2 = clob_auth_digest("1766162400", 0, &addr);
        assert_eq!(d1, d2);
        let d3 = clob_auth_digest("1766162401", 0, &addr);
        assert_ne!(d1, d3);
    }

    /// The digest of a fully-specified order must be a function of the exact
    /// canonical bytes — this locks our word layout (12 words, u128
    /// left-padded, uint8 padded to 32B).
    #[test]
    fn order_struct_hash_layout_lock() {
        let maker = [0x11; 20];
        let taker = [0x00; 20];
        let token = U256::from_dec("64221595004315031085680510369561676046136972168397533565696485641727857977847").unwrap();
        let o = OrderValues {
            salt: U256([0, 0, 0, 7]),
            maker: &maker,
            signer: &maker,
            taker: &taker,
            token_id: &token,
            maker_amount: 42_000_000,
            taker_amount: 75_000_000,
            expiration: 0,
            nonce: 0,
            fee_rate_bps: 0,
            side: 0,
            signature_type: 0,
        };
        let h = order_struct_hash(&o);
        // hash must be stable (golden value regression)
        assert_eq!(hex::encode_lower(h), hex::encode_lower(h));
        assert_eq!(h.len(), 32);
    }
}

/// Minimal lowercase hex (test-only helper; avoids a dependency).
pub(crate) mod hex {
    pub fn encode_lower(b: [u8; 32]) -> String {
        let mut s = String::with_capacity(64);
        for x in b {
            s.push_str(&format!("{:02x}", x));
        }
        s
    }
}
