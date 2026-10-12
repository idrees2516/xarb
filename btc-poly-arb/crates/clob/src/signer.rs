//! secp256k1 signing wallet (pure Rust, k256).
//!
//! Address = keccak256(uncompressed_pubkey[1..])[12..].
//! Signatures are 65 bytes r||s||v with v = 27 + recovery_id, exactly what
//! `Account._sign_hash` produces in eth_account (which Polymarket's
//! contracts and API expect for EOA signature type 0).

use k256::ecdsa::signature::hazmat::PrehashVerifier;
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use k256::elliptic_curve::sec1::ToEncodedPoint;

use crate::spec::keccak256;

#[derive(Clone)]
pub struct Wallet {
    sk: SigningKey,
    pub address: [u8; 20],
}

fn pub_key_to_address(vk: &VerifyingKey) -> [u8; 20] {
    let pt = vk.to_encoded_point(false); // 0x04 || X || Y
    let raw = pt.as_bytes(); // 65 bytes
    let h = keccak256(&raw[1..65]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&h[12..32]);
    addr
}

impl Wallet {
    /// `hex_pk` with or without 0x prefix, 64 hex chars.
    pub fn from_hex(hex_pk: &str) -> anyhow::Result<Wallet> {
        let h = hex_pk.trim().trim_start_matches("0x");
        if h.len() != 64 {
            anyhow::bail!("private key must be 64 hex chars, got {}", h.len());
        }
        let mut bytes = [0u8; 32];
        for i in 0..32 {
            bytes[i] = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16)?;
        }
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(pk: &[u8; 32]) -> anyhow::Result<Wallet> {
        let sk = SigningKey::from_bytes(pk.into())
            .map_err(|e| anyhow::anyhow!("invalid private key: {e}"))?;
        let address = pub_key_to_address(sk.verifying_key());
        Ok(Wallet { sk, address })
    }

    pub fn address_hex(&self) -> String {
        to_hex(&self.address)
    }

    /// Sign a 32-byte digest; returns (r[32], s[32], v) with v in {27, 28}.
    pub fn sign_digest(&self, digest: &[u8; 32]) -> ([u8; 32], [u8; 32], u8) {
        let (sig, rec) = self
            .sk
            .sign_prehash_recoverable(digest)
            .expect("secp256k1 signing cannot fail on valid input");
        let (r_g, s_g) = sig.split_bytes();
        let mut r = [0u8; 32];
        r.copy_from_slice(&r_g);
        let mut s = [0u8; 32];
        s.copy_from_slice(&s_g);
        let v = 27 + rec.to_byte();
        (r, s, v)
    }

    /// 65-byte r||s||v.
    pub fn sign_digest_65(&self, digest: &[u8; 32]) -> [u8; 65] {
        let (r, s, v) = self.sign_digest(digest);
        let mut out = [0u8; 65];
        out[0..32].copy_from_slice(&r);
        out[32..64].copy_from_slice(&s);
        out[64] = v;
        out
    }

    /// 0x-prefixed signature (as the REST API expects).
    pub fn sign_digest_hex(&self, digest: &[u8; 32]) -> String {
        let sig = self.sign_digest_65(digest);
        format!("0x{}", to_hex(&sig))
    }

    /// Public key bytes (for proxy/gnosis sig types, verification).
    pub fn public_key_bytes(&self) -> [u8; 64] {
        let pt = self.sk.verifying_key().to_encoded_point(false);
        let raw = pt.as_bytes();
        let mut out = [0u8; 64];
        out.copy_from_slice(&raw[1..65]);
        out
    }

    /// Verify a signature over a digest (self-test / audit path).
    pub fn verify(&self, digest: &[u8; 32], sig65: &[u8; 65]) -> bool {
        let mut r = [0u8; 32];
        r.copy_from_slice(&sig65[0..32]);
        let mut s = [0u8; 32];
        s.copy_from_slice(&sig65[32..64]);
        let v = sig65[64];
        let rec = RecoveryId::new((v - 27) & 1 == 1, false);
        let rf: k256::FieldBytes = r.into();
        let sf: k256::FieldBytes = s.into();
        let Ok(sig) = Signature::from_scalars(rf, sf) else {
            return false;
        };
        // recover the signer and compare addresses
        let vk = match k256::ecdsa::VerifyingKey::recover_from_prehash(digest, &sig, rec) {
            Ok(v) => v,
            Err(_) => return false,
        };
        pub_key_to_address(&vk) == self.address
    }
}

pub fn to_hex(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(HEX[(x >> 4) as usize] as char);
        s.push(HEX[(x & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known vector: private key 1 -> address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    #[test]
    fn address_derivation_known() {
        let w = Wallet::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        assert_eq!(
            w.address_hex(),
            "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let w = Wallet::from_hex(
            "4646464646464646464646464646464646464646464646464646464646464646",
        )
        .unwrap();
        let digest = keccak256(b"polymarket order test vector");
        let sig = w.sign_digest_65(&digest);
        assert!(sig[64] == 27 || sig[64] == 28, "v={}", sig[64]);
        assert!(w.verify(&digest, &sig));
        // wrong digest must fail
        let other = keccak256(b"other");
        assert!(!w.verify(&other, &sig));
    }

    #[test]
    fn hex_roundtrip() {
        let w = Wallet::from_hex("0x4646464646464646464646464646464646464646464646464646464646464646").unwrap();
        let w2 = Wallet::from_hex("4646464646464646464646464646464646464646464646464646464646464646").unwrap();
        assert_eq!(w.address_hex(), w2.address_hex());
    }
}
