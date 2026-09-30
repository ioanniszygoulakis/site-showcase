#!/bin/zsh
# Double-click to launch. First run installs dependencies.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || { echo "Node.js is required: https://nodejs.org"; read; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg"; read; exit 1; }
[ -d node_modules ] || { npm install && npx playwright install chromium; }
npm start
