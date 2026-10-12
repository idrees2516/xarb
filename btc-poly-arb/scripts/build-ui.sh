#!/usr/bin/env bash
# Build the Leptos (Rust -> WASM) frontend into crates/ui/dist.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
# NOTE: build manually (trunk 0.21 has a --no-color incompatibility with
# cargo >= 1.99); requires wasm-bindgen-cli matching the wasm-bindgen crate
# version (check crates/ui/Cargo.lock; 0.2.129 at time of writing)
command -v wasm-bindgen >/dev/null || cargo install wasm-bindgen-cli --version 0.2.129 --locked
set -e
cargo build --release --target wasm32-unknown-unknown -p ui
rm -rf crates/ui/dist
mkdir -p crates/ui/dist
wasm-bindgen --target web --out-dir crates/ui/dist --out-name ui target/wasm32-unknown-unknown/release/ui.wasm
cp crates/ui/styles.css crates/ui/dist/
# index.html with the WASM module loader
cat > crates/ui/dist/index.html <<"HTML"
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>polyarb — Polymarket x Binance</title>
    <link rel="stylesheet" href="styles.css" />
    <script type="module">
      import init from "./ui.js";
      init().catch((e) => {
        document.body.innerHTML =
          "<pre style='color:#ff5470;padding:2em;font-family:monospace'>failed to boot WASM: " + e + "</pre>";
      });
    </script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
HTML
echo "ui built -> crates/ui/dist"
