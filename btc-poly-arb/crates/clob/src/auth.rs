//! L1 (EIP-712 ClobAuth) and L2 (HMAC) request authentication.

use crate::eip712::clob_auth_digest;
use crate::signer::{to_hex, Wallet};
use crate::spec::*;

/// API credentials derived from the wallet.
#[derive(Clone, Debug)]
pub struct ApiCreds {
    pub api_key: String,
    pub secret: String,
    pub passphrase: String,
}

/// L1 headers for /auth/derive-api-key (and other L1 endpoints).
pub fn level1_headers(wallet: &Wallet, timestamp: i64, nonce: u64) -> Vec<(String, String)> {
    let ts = timestamp.to_string();
    let digest = clob_auth_digest(&ts, nonce, &wallet.address);
    let sig = wallet.sign_digest_hex(&digest);
    vec![
        (H_ADDRESS.to_string(), wallet.address_hex()),
        (H_SIGNATURE.to_string(), sig),
        (H_TIMESTAMP.to_string(), ts),
        (H_NONCE.to_string(), nonce.to_string()),
    ]
}

/// L2 headers for authenticated requests.
///
/// HMAC key = base64url-decoded `secret`; message =
/// `timestamp + method + request_path + body`; output base64url
/// (py-clob-client `signing/hmac.py`).
pub fn level2_headers(
    wallet: &Wallet,
    creds: &ApiCreds,
    timestamp: i64,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Vec<(String, String)> {
    let ts = timestamp.to_string();
    let mut msg = format!("{}{}{}", ts, method, path);
    if let Some(b) = body {
        msg.push_str(b);
    }
    let key = b64_decode_url(&creds.secret).unwrap_or_default();
    let mac = hmac_sha256(&key, msg.as_bytes());
    let sig = b64_encode_url(&mac);
    vec![
        (H_ADDRESS.to_string(), wallet.address_hex()),
        (H_SIGNATURE.to_string(), sig),
        (H_TIMESTAMP.to_string(), ts),
        (H_API_KEY.to_string(), creds.api_key.clone()),
        (H_PASSPHRASE.to_string(), creds.passphrase.clone()),
    ]
}

// ---------------------------------------------------------------------------
// minimal, dependency-free crypto helpers (HMAC-SHA256 + base64url)
// ---------------------------------------------------------------------------

/// HMAC-SHA256 (RFC 2104), constant-time-ish, no allocation for small keys.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    // SHA-256 compression implementation
    fn sha256(data: &[u8]) -> [u8; 32] {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];
        let mut msg = data.to_vec();
        let bit_len = (data.len() as u64) * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());
        for block in msg.chunks(64) {
            let mut w = [0u32; 64];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([
                    block[i * 4],
                    block[i * 4 + 1],
                    block[i * 4 + 2],
                    block[i * 4 + 3],
                ]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }
            let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
                (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ ((!e) & g);
                let t1 = hh
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let t2 = s0.wrapping_add(maj);
                hh = g;
                g = f;
                f = e;
                e = d.wrapping_add(t1);
                d = c;
                c = b;
                b = a;
                a = t1.wrapping_add(t2);
            }
            h[0] = h[0].wrapping_add(a);
            h[1] = h[1].wrapping_add(b);
            h[2] = h[2].wrapping_add(c);
            h[3] = h[3].wrapping_add(d);
            h[4] = h[4].wrapping_add(e);
            h[5] = h[5].wrapping_add(f);
            h[6] = h[6].wrapping_add(g);
            h[7] = h[7].wrapping_add(hh);
        }
        let mut out = [0u8; 32];
        for i in 0..8 {
            out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
        }
        out
    }

    let mut k = [0u8; 64];
    if key.len() <= 64 {
        k[..key.len()].copy_from_slice(key);
    } else {
        let d = sha256(key);
        k[..32].copy_from_slice(&d);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(message);
    let inner_hash = sha256(&inner);
    let mut outer = Vec::with_capacity(96);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha256(&outer)
}

/// base64url *decode* without padding.
pub fn b64_decode_url(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for ch in s.bytes() {
        if ch == b'=' {
            break;
        }
        let v = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a' + 26) as u32,
            b'0'..=b'9' => (ch - b'0' + 52) as u32,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// base64url *encode* without padding.
pub fn b64_encode_url(data: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | data[i + 2] as u32;
        s.push(CHARS[(n >> 18) as usize & 63] as char);
        s.push(CHARS[(n >> 12) as usize & 63] as char);
        s.push(CHARS[(n >> 6) as usize & 63] as char);
        s.push(CHARS[n as usize & 63] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        s.push(CHARS[(n >> 18) as usize & 63] as char);
        s.push(CHARS[(n >> 12) as usize & 63] as char);
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        s.push(CHARS[(n >> 18) as usize & 63] as char);
        s.push(CHARS[(n >> 12) as usize & 63] as char);
        s.push(CHARS[(n >> 6) as usize & 63] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_rfc4231_case1() {
        // RFC 4231 test case 1
        let key = b"\x0b".repeat(20);
        let mac = hmac_sha256(&key, b"Hi There");
        let expect = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
        assert_eq!(to_hex(&mac), expect);
    }

    #[test]
    fn hmac_sha256_rfc4231_case2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let expect = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
        assert_eq!(to_hex(&mac), expect);
    }

    #[test]
    fn b64url_roundtrip() {
        let data = [0u8, 1, 2, 250, 251, 252, 253, 254, 255];
        let enc = b64_encode_url(&data);
        let dec = b64_decode_url(&enc).unwrap();
        assert_eq!(dec, data);
        // python: base64.urlsafe_b64encode(b'x').rstrip(b'=') -> 'eA'
        assert_eq!(b64_encode_url(b"x"), "eA");
        assert_eq!(b64_decode_url("eA").unwrap(), b"x");
        assert_eq!(b64_encode_url(b"ab"), "YWI");
    }

    #[test]
    fn level2_headers_shape() {
        let w = Wallet::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        let creds = ApiCreds {
            api_key: "k".into(),
            secret: b64_encode_url(&[0x0b; 20]),
            passphrase: "p".into(),
        };
        let h = level2_headers(&w, &creds, 1_766_162_400, "POST", "/order", Some("{\"a\":1}"));
        let names: Vec<&str> = h.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            vec!["POLY_ADDRESS", "POLY_SIGNATURE", "POLY_TIMESTAMP", "POLY_API_KEY", "POLY_PASSPHRASE"]
        );
        let ts = h.iter().find(|(k, _)| k == "POLY_TIMESTAMP").unwrap().1.clone();
        assert_eq!(ts, "1766162400");
        // signature deterministic
        let h2 = level2_headers(&w, &creds, 1_766_162_400, "POST", "/order", Some("{\"a\":1}"));
        assert_eq!(h[1].1, h2[1].1);
        // body changes signature
        let h3 = level2_headers(&w, &creds, 1_766_162_400, "POST", "/order", Some("{\"a\":2}"));
        assert_ne!(h[1].1, h3[1].1);
    }

    #[test]
    fn level1_headers_shape() {
        let w = Wallet::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        let h = level1_headers(&w, 1_766_162_400, 0);
        let names: Vec<&str> = h.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["POLY_ADDRESS", "POLY_SIGNATURE", "POLY_TIMESTAMP", "POLY_NONCE"]);
        let sig = &h.iter().find(|(k, _)| k == "POLY_SIGNATURE").unwrap().1;
        assert!(sig.starts_with("0x") && sig.len() == 132);
    }
}
