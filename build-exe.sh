#!/usr/bin/env bash
# Builds MKWorldCourseEditor.exe (Windows): the editor page, wrapped in the Go launcher.
# Needs Node 18+ and Go 1.24+. Run: ./build-exe.sh   (on Windows, use Git Bash, or the same steps by hand)
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
node build.mjs
cp dist/MKWorld-Course-Editor.html launcher/editor.html
VER=$(grep -o "EDITOR_VER = '[^']*'" src/main.js | cut -d"'" -f2)
cd launcher
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w" -o "../MKWorldCourseEditor $VER.exe"
echo "Built MKWorldCourseEditor $VER.exe"
