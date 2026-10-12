#!/usr/bin/env bash
# Simulate 30 windows against a 500ms-lagged market maker, then the
# zero-lag control — the difference is the strategy's edge.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
cargo run --release -p cli -- sim --windows 30 --lag-ms 500 --speed 100 --seed 7
cargo run --release -p cli -- sim --windows 30 --lag-ms 0   --speed 100 --seed 7
