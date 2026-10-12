//! Verified constants for the Polymarket CLOB (Polygon PoS).
//!
//! Every value below was cross-checked against:
//!   * py-clob-client  `py_clob_client/config.py`          (contracts)
//!   * py-order-utils  `py_order_utils/builders/base_builder.py` (domain)
//!   * py-order-utils  `py_order_utils/model/order.py`     (struct layout)
//!   * py-clob-client  `py_clob_client/signing/eip712.py`  (ClobAuth)
//!   * py-clob-client  `py_clob_client/headers/headers.py` (header names)
//!   * py-eip712-structs `types.py`                        (value encoding)

/// Polygon PoS mainnet chain id.
pub const CHAIN_ID: u64 = 137;

/// CTF Exchange (standard risk markets). BTC up/down 5m markets are
/// standard-risk (negRisk = false on the live API).
pub const EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
/// Neg-risk exchange.
pub const EXCHANGE_NEG_RISK: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
/// Collateral (USDC.e) on Polygon.
pub const COLLATERAL: &str = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
/// Conditional Tokens Framework.
pub const CONDITIONAL_TOKENS: &str = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

/// EIP-712 domain for orders.
pub const ORDER_DOMAIN_NAME: &str = "Polymarket CTF Exchange";
pub const ORDER_DOMAIN_VERSION: &str = "1";

/// Canonical order type string (hash preimage of the type hash).
/// NOTE: `side` and `signatureType` are **uint8**.
pub const ORDER_TYPEHASH_STR: &str = concat!(
    "Order(",
    "uint256 salt,",
    "address maker,",
    "address signer,",
    "address taker,",
    "uint256 tokenId,",
    "uint256 makerAmount,",
    "uint256 takerAmount,",
    "uint256 expiration,",
    "uint256 nonce,",
    "uint256 feeRateBps,",
    "uint8 side,",
    "uint8 signatureType",
    ")"
);

/// Domain type string for a domain with name/version/chainId/verifyingContract.
pub const DOMAIN_TYPEHASH_STR: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/// Domain type string without verifyingContract (ClobAuth uses this).
pub const DOMAIN_TYPEHASH_NO_ADDR_STR: &str =
    "EIP712Domain(string name,string version,uint256 chainId)";

/// ClobAuth (L1 auth message).
pub const CLOB_AUTH_DOMAIN_NAME: &str = "ClobAuthDomain";
pub const CLOB_AUTH_DOMAIN_VERSION: &str = "1";
pub const CLOB_AUTH_TYPEHASH_STR: &str =
    "ClobAuth(address address,string timestamp,uint256 nonce,string message)";
pub const CLOB_AUTH_MESSAGE: &str = "This message attests that I control the given wallet";

/// Order side encoding (EIP-712 uint8 + JSON string).
pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

/// Signature types.
pub const SIG_EOA: u8 = 0;
pub const SIG_POLY_PROXY: u8 = 1;
pub const SIG_POLY_GNOSIS_SAFE: u8 = 2;

/// L2 header names.
pub const H_ADDRESS: &str = "POLY_ADDRESS";
pub const H_SIGNATURE: &str = "POLY_SIGNATURE";
pub const H_TIMESTAMP: &str = "POLY_TIMESTAMP";
pub const H_API_KEY: &str = "POLY_API_KEY";
pub const H_PASSPHRASE: &str = "POLY_PASSPHRASE";
pub const H_NONCE: &str = "POLY_NONCE";

/// REST endpoints (paths only; py-clob-client `endpoints.py`).
pub const EP_TIME: &str = "/time";
pub const EP_DERIVE_API_KEY: &str = "/auth/derive-api-key";
pub const EP_POST_ORDER: &str = "/order";
pub const EP_CANCEL_ALL: &str = "/cancel-all";
pub const EP_BOOK: &str = "/book";
pub const EP_BALANCE: &str = "/balance-allowance";
pub const EP_DATA_TRADES: &str = "/data/trades";
pub const EP_MARKETS: &str = "/markets";

/// Order types accepted by POST /order ("orderType" field).
pub const ORDER_TYPE_GTC: &str = "GTC";
pub const ORDER_TYPE_FOK: &str = "FOK";
pub const ORDER_TYPE_FAK: &str = "FAK";
pub const ORDER_TYPE_GTD: &str = "GTD";

/// Token/collateral decimals.
pub const TOKEN_DECIMALS: u64 = 6;
pub const TOKEN_SCALE: u64 = 1_000_000;

/// keccak256 (tiny-keccak wrapper).
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut out = [0u8; 32];
    let mut k = Keccak::v256();
    k.update(data);
    k.finalize(&mut out);
    out
}
