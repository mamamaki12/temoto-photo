#!/usr/bin/env bash
# PC 版（Windows 64bit）を作る。Linux・Mac・Windows（Git Bash）のどれでも動く（Windows の機械は要らない）。
#   使い方: sh desktop/build-win.sh   → desktop/dist/TemotoPhoto-win-x64.zip
#   中身: TemotoPhoto.exe（Electron）＋ resources/app（main.cjs・PC 用の ONNX Runtime）＋ resources/web（Web 版のファイルそのまま）
set -euo pipefail
cd "$(dirname "$0")"
ELECTRON=38.2.0
OUT=dist/TemotoPhoto
CACHE=$(mkdir -p "${CACHE:-.cache}" && cd "${CACHE:-.cache}" && pwd)
mkdir -p "$CACHE"

# 1. Electron の Windows 版
Z="$CACHE/electron-v$ELECTRON-win32-x64.zip"
[ -s "$Z" ] || curl -fL --retry 4 -o "$Z" "https://github.com/electron/electron/releases/download/v$ELECTRON/electron-v$ELECTRON-win32-x64.zip"
rm -rf dist && mkdir -p "$OUT"
unzip -q "$Z" -d "$OUT"
mv "$OUT/electron.exe" "$OUT/TemotoPhoto.exe"
rm -f "$OUT/resources/default_app.asar"

# 2. アプリ本体（main.cjs）と、PC 用の ONNX Runtime（Windows の x64 のファイルだけ）
APP="$OUT/resources/app"; mkdir -p "$APP/node_modules"
cp main.cjs package.json icon.png "$APP/"
ORT=$(node -p "require('./package.json').dependencies['onnxruntime-node']")
[ -d "$CACHE/npm/node_modules/onnxruntime-node" ] || (mkdir -p "$CACHE/npm" && cd "$CACHE/npm" && npm init -y >/dev/null \
  && npm i --no-audit --no-fund --ignore-scripts "onnxruntime-node@$ORT" resedit@2.0.3 >/dev/null)
for m in onnxruntime-node onnxruntime-common; do
  mkdir -p "$APP/node_modules/$m"
  cp -R "$CACHE/npm/node_modules/$m/dist" "$CACHE/npm/node_modules/$m/package.json" "$APP/node_modules/$m/"
  [ -f "$CACHE/npm/node_modules/$m/LICENSE" ] && cp "$CACHE/npm/node_modules/$m/LICENSE" "$APP/node_modules/$m/"
done
B="bin/napi-v6/win32/x64"; mkdir -p "$APP/node_modules/onnxruntime-node/$B"
cp "$CACHE/npm/node_modules/onnxruntime-node/$B/"* "$APP/node_modules/onnxruntime-node/$B/"

# 3. Web 版のファイル（GitHub Pages に出すものと同じ。scripts/make-site.sh）
(cd .. && sh scripts/make-site.sh >/dev/null) && cp -R ../_site "$OUT/resources/web" && rm -f "$OUT/resources/web/.nojekyll"

# 4. .exe のアイコンと名前
NODE_PATH="$CACHE/npm/node_modules" node set-exe-info.cjs "$OUT/TemotoPhoto.exe" icon.png "$(node -p "require('./package.json').version")"

# 5. まとめて zip に
(cd dist && zip -qr -9 TemotoPhoto-win-x64.zip TemotoPhoto)
ls -la dist/TemotoPhoto-win-x64.zip
