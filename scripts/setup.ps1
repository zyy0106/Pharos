$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Write-Host "== Pharos setup ==" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js。请安装 Node.js 18+：https://nodejs.org/"
}
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw "Node.js 版本过旧，需要 18+。当前：$nodeMajor" }
Write-Host "[OK] Node.js $(node --version)"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "未找到 uv。请按 https://docs.astral.sh/uv/getting-started/installation/ 安装后重新运行。"
}
Write-Host "[OK] uv $(uv --version)"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env'))) {
  Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination (Join-Path $projectRoot '.env')
  Write-Host "[INIT] 已创建 .env；真实模型参数请在 WebUI 设置页填写。"
} else {
  Write-Host "[KEEP] 已存在 .env，不覆盖。"
}

Write-Host "[INSTALL] npm ci"
npm ci
Write-Host "[INSTALL] uv sync --extra dev"
uv sync --extra dev
Write-Host "[DONE] 安装完成。运行：npm run start:framework"
