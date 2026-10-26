#!/bin/sh
# Crewroom installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/0GithubDoN/crewroom/main/install.sh | sh
set -e
PACKAGE="https://github.com/0GithubDoN/crewroom/archive/refs/heads/main.tar.gz"

node_major() {
  node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0
}

echo "Installing Crewroom..."
if [ "$(node_major)" = "" ] || [ "$(node_major)" -lt 20 ] 2>/dev/null; then
  echo "Crewroom needs Node.js 20 or newer."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    echo "Install Node.js LTS from https://nodejs.org (or with your package manager), then run this again."
    exit 1
  fi
fi

if ! npm install -g "$PACKAGE" 2>/dev/null; then
  echo "Global npm install needs more permissions; retrying with sudo..."
  sudo npm install -g "$PACKAGE"
fi

echo
echo "Crewroom installed. Now adding it to your AI apps..."
crewroom connect < /dev/tty || crewroom connect --yes
echo
echo "Done! In a project folder run:  crewroom start --open"
