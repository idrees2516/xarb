//! xarb-poly — Polymarket: gamma discovery, dual-token CLOB WS book feed,
//! CLOB REST (L1/L2 auth) and real EIP-712 order signing over the CTF
//! Exchange.

pub mod clob_rest;
pub mod clob_ws;
pub mod eip712;
pub mod gamma;

pub use clob_rest::ClobClient;
pub use clob_ws::{PmOut, PmSnapshot, SideSnap};
pub use eip712::Creds;
