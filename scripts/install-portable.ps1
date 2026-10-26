# Installs the portable Windows package (shipped next to this script) for the current user:
# copies it to %LOCALAPPDATA%\Crewroom, puts "crewroom" on the PATH and connects the AI apps.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
function Run-Crewroom([string[]]$CrewroomArgs) {
  # Native output on stderr must not abort the install (Windows PowerShell treats it as an error).
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & (Join-Path $dest 'node.exe') (Join-Path $dest 'app\bin\crewroom.js') @CrewroomArgs } finally { $ErrorActionPreference = $old }
}
$dest = Join-Path $env:LOCALAPPDATA 'Crewroom'

Write-Host "Installing Crewroom to $dest ..."
# An older version may still be running in the background: stop it so its files can be replaced.
if (Test-Path (Join-Path $dest 'crewroom.cmd')) {
  Run-Crewroom @('stop', '--all') | Out-Null
  Start-Sleep -Milliseconds 500
}
if ((Resolve-Path $src).Path -ne $dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Remove-Item (Join-Path $dest 'app') -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $src '*') -Destination $dest -Recurse -Force
}

# Add to the user's PATH (not the machine's: no admin rights needed).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dest)) {
  $newPath = if ($userPath) { "$userPath;$dest" } else { $dest }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host 'Added Crewroom to your PATH (open a new terminal to use the "crewroom" command).'
}
$env:Path = "$env:Path;$dest"

Write-Host ''
Write-Host 'Adding Crewroom to your AI apps...'
Run-Crewroom @('connect')
Write-Host ''
Write-Host 'Done! Restart your AI apps, then in a project folder run:  crewroom start --open'
