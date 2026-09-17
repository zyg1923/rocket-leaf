# Toolchain for this machine. GOPATH is F:\job\go (module cache + wails3).
# The compiler itself lives in F:\job\go\1.26.6\go — that directory is GOROOT.
$GoRoot = 'F:\job\go\1.26.6\go'
$GoPath = 'F:\job\go'

$env:GOROOT = $GoRoot
$env:GOPATH = $GoPath
$env:PATH = "$GoRoot\bin;$GoPath\bin;$env:PATH"

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw "go.exe not found under $GoRoot\bin"
}
if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
    throw "wails3.exe not found under $GoPath\bin"
}
