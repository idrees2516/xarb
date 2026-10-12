//! clob — Polymarket CLOB execution layer.
//!
//! Implements, byte-for-byte against the reference `py-clob-client` +
//! `py-order-utils` (see /reference in the repo for the exact sources):
//!
//! * EIP-712 order signing for the CTF Exchange (secp256k1 + keccak256)
//! * L1 ClobAuth (derive API credentials)
//! * L2 HMAC request headers
//! * FAK/FOK order payload construction with CLOB rounding rules
//! * A pre-warmed HTTP/2 REST client
//! * An optional pre-signed order ladder (zero-signature fire path)

pub mod auth;
pub mod client;
pub mod eip712;
pub mod ladder;
pub mod order;
pub mod signer;
pub mod spec;

pub use client::ClobClient;
pub use signer::Wallet;
