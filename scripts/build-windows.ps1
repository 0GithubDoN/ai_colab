# Builds the portable Windows package: Crewroom with its own node.exe, so nothing else needs
# to be installed. Run on Windows after `npm ci --omit=dev` (the release workflow does this).
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$pkg = Join-Path $dist 'Crewroom'
$app = Join-Path $pkg 'app'
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $app | Out-Null

# The app itself, with its production dependencies.
foreach ($item in 'bin', 'src', 'public', 'node_modules', 'package.json', 'LICENSE', 'README.md') {
  Copy-Item (Join-Path $root $item) -Destination $app -Recurse -Force
}
# The official node.exe this runner uses.
Copy-Item (Get-Command node).Source -Destination (Join-Path $pkg 'node.exe')

Set-Content -Encoding ascii -Path (Join-Path $pkg 'crewroom.cmd') -Value '@"%~dp0node.exe" "%~dp0app\bin\crewroom.js" %*'
Set-Content -Encoding ascii -Path (Join-Path $pkg 'Install Crewroom.cmd') -Value @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-portable.ps1"
pause
'@
Copy-Item (Join-Path $PSScriptRoot 'install-portable.ps1') -Destination $pkg
Set-Content -Encoding utf8 -Path (Join-Path $pkg 'README.txt') -Value @"
Crewroom $Version for Windows (portable, includes Node.js)

1. Double-click "Install Crewroom.cmd".
   It copies Crewroom to %LOCALAPPDATA%\Crewroom, adds "crewroom" to your PATH
   and adds Crewroom to your AI apps (Claude, Codex, Antigravity, Cursor...).
2. Restart your AI apps.
3. In a project folder, open a terminal and run:  crewroom start --open

To update later, download the new zip and run "Install Crewroom.cmd" again.
More: https://github.com/0GithubDoN/crewroom
"@

$zip = Join-Path $dist "Crewroom-$Version-windows-x64.zip"
Compress-Archive -Path $pkg -DestinationPath $zip -CompressionLevel Optimal

$notes = Join-Path $dist 'RELEASE_NOTES.md'
Set-Content -Encoding utf8 -Path $notes -Value @"
## Install

**Windows, no Node.js needed:** download **Crewroom-$Version-windows-x64.zip**, unzip it and double-click **Install Crewroom.cmd**. Then restart your AI apps.

**Windows with Node.js (PowerShell):**
``````powershell
irm https://raw.githubusercontent.com/0GithubDoN/crewroom/main/install.ps1 | iex
``````

**macOS / Linux:**
``````bash
curl -fsSL https://raw.githubusercontent.com/0GithubDoN/crewroom/main/install.sh | sh
``````

Then, in a project folder: ``crewroom start --open``. Your AI apps join with the invite code.

## Highlights
- One room for Claude, Codex, Antigravity/Gemini, ChatGPT, Cursor and more: a lead, tasks, reviews and a live dashboard.
- Tasks with a definition of done and checks that run by themselves; a diff for every task; reviews with ratings.
- Ranks earned from each AI's track record; the lead gives lower ranks more detailed instructions.
- Team ledger, shared toolbox, room memory (import your lead AI's notes), room rules and your name.
- Built to save tokens: focus mode, long waits, chapters and fresh chats, context warnings, small tool lists.
"@
Write-Host "Built $zip"
