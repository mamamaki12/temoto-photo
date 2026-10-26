#!/bin/sh
# nlm.c → nlm.wasm.js（WebAssembly を base64 で埋め込んだ JavaScript）。clang（wasm32）と wasm-ld が要る
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -mno-simd128 -ffp-contract=off -fno-builtin -nostdlib \
  -Wl,--no-entry -Wl,--export=nlm_offset -Wl,--export=__heap_base -Wl,-z,stack-size=8192 -Wl,--import-memory -o /tmp/nlm.wasm nlm.c
{
  echo '// scripts/nlm/build.sh で作ったファイル（元は scripts/nlm/nlm.c）。手で書き換えない'
  printf "export const NLM_WASM = Uint8Array.from(atob('%s'), (c) => c.charCodeAt(0));\n" "$(base64 -w0 /tmp/nlm.wasm)"
} > ../../nlm.wasm.js
