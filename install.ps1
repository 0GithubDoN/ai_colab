# Crewroom installer for Windows.
#   irm https://raw.githubusercontent.com/0GithubDoN/crewroom/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Package = 'https://github.com/0GithubDoN/crewroom/archive/refs/heads/main.tar.gz'

function Get-NodeMajor {
  try { return [int]((node --version) -replace '^v(\d+).*', '$1') } catch { return 0 }
}

function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host "Installing Crewroom..." -ForegroundColor Cyan
if ((Get-NodeMajor) -lt 20) {
  Write-Host "Crewroom needs Node.js 20 or newer." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $answer = Read-Host "Install Node.js LTS now with winget? [Y/n]"
    if ($answer -eq '' -or $answer -match '^[yY]') {
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      Update-PathFromRegistry
    }
  }
  if ((Get-NodeMajor) -lt 20) {
    Write-Host "Please install Node.js LTS from https://nodejs.org, open a new terminal, and run this again." -ForegroundColor Red
    exit 1
  }
}

# Call npm.cmd (not npm.ps1) so this works even where PowerShell blocks scripts.
& npm.cmd install -g $Package
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed." -ForegroundColor Red; exit 1 }
Update-PathFromRegistry

# PowerShell's default policy on many PCs blocks npm's command shims (crewroom.ps1).
# RemoteSigned for the current user is the usual setting for developers.
$policy = Get-ExecutionPolicy
if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
  Write-Host ""
  Write-Host "PowerShell on this PC blocks installed commands like 'crewroom' (execution policy: $policy)." -ForegroundColor Yellow
  $answer = Read-Host "Allow them for your user account (Set-ExecutionPolicy RemoteSigned -Scope CurrentUser)? [Y/n]"
  if ($answer -eq '' -or $answer -match '^[yY]') {
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
  } else {
    Write-Host "OK. In PowerShell type 'crewroom.cmd' instead of 'crewroom' (Command Prompt works with plain 'crewroom')." -ForegroundColor Yellow
  }
}

$crewroom = (Get-Command crewroom.cmd -ErrorAction SilentlyContinue).Source
if (-not $crewroom) { $crewroom = Join-Path $env:APPDATA 'npm\crewroom.cmd' }

Write-Host ""
Write-Host "Crewroom installed. Now adding it to your AI apps..." -ForegroundColor Green
& $crewroom connect
Write-Host ""
Write-Host "Done! Open a NEW terminal in your project folder and run:  crewroom start --open" -ForegroundColor Green
