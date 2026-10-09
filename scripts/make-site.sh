#!/usr/bin/env sh
# 公開するファイル（アプリ本体）だけを _site/ に集める
set -eu
rm -rf _site
mkdir -p _site
cp index.html manifest.webmanifest icon.svg style.css ./*.js _site/
cp -R vendor _site/
rm -f _site/playwright.config.js
touch _site/.nojekyll
echo "_site/ を作成しました"
