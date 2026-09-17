# Launch Rocket Leaf as a Wails desktop app (not Vite-in-browser).
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
wails3 task dev
