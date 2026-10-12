#!/usr/bin/env bash
# Build + run the paper-mode stack with dashboard on :8080.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
[ -f crates/ui/dist/index.html ] && ! grep -q "UI not built" crates/ui/dist/index.html && ./scripts/build-ui.sh || echo "(ui not built; serving placeholder)"
cargo run --release -p cli -- run --mode paper
