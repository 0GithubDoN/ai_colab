# Crewroom installer for Windows.
#   irm https://raw.githubusercontent.com/0GithubDoN/ai_colab/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Package = 'https://github.com/0GithubDoN/ai_colab/archive/refs/heads/main.tar.gz'

function Get-NodeMajor {
  try { return [int]((node --version) -replace '^v(\d+).*', '$1') } catch { return 0 }
}

Write-Host "Installing Crewroom..." -ForegroundColor Cyan
if ((Get-NodeMajor) -lt 20) {
  Write-Host "Crewroom needs Node.js 20 or newer." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $answer = Read-Host "Install Node.js LTS now with winget? [Y/n]"
    if ($answer -eq '' -or $answer -match '^[yY]') {
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
  }
  if ((Get-NodeMajor) -lt 20) {
    Write-Host "Please install Node.js LTS from https://nodejs.org, open a new terminal, and run this again." -ForegroundColor Red
    exit 1
  }
}

npm install -g $Package
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Crewroom installed. Now adding it to your AI apps..." -ForegroundColor Green
crewroom connect
Write-Host ""
Write-Host "Done! In a project folder run:  crewroom start --open" -ForegroundColor Green
