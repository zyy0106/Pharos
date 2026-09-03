$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$ports = 5174..5190

Set-Location -LiteralPath $projectRoot
foreach ($port in $ports) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/framework/health" -TimeoutSec 1
    if ($health.service -eq "supervised-framework") {
      $url = "http://127.0.0.1:$port"
      Start-Process $url
      Write-Host "Supervised Modeling Workbench 已在运行：$url"
      exit 0
    }
  } catch {}
}

Write-Host "正在启动 Supervised Modeling Workbench，日志将在新窗口显示..."
$command = "Set-Location -LiteralPath '$projectRoot'; npm run start:framework"
Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $command) -WorkingDirectory $projectRoot

for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 250
  foreach ($port in $ports) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/framework/health" -TimeoutSec 1
      if ($health.service -eq "supervised-framework") {
        $url = "http://127.0.0.1:$port"
        Start-Process $url
        Write-Host "Supervised Modeling Workbench 已启动：$url"
        exit 0
      }
    } catch {}
  }
}
throw "服务未能在预期时间内启动，请查看新窗口中的错误日志。"
