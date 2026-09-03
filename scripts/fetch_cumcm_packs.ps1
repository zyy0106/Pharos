$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$out = Join-Path $desktop '全国大学生数学建模竞赛_2021-2025_题目-优先论文-附件'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$nodes = @{
  '2025'='03c91a444e62eee81a3740fa97a461a6'; '2024'='a0c1fb5c31d43551f08cd8ad16870444'; '2023'='c74d72127066f510a5723a94b5323a26'; '2022'='388239ded4b057d37b7b8e51e33fe903'; '2021'='90d223833c1eb50f899aa096a66c6896'
}
$paperIndex = @{
  '2025'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2025qgdxssxjmjslwzs/'; '2024'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2024qgdxssxjmjslwzs/'; '2023'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2023qgdxssxjmjslwzs/2023gjsbqgdxssxjmjslwzs.shtml'; '2022'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2022qgdxssxjmjslwzs/2022gjsbqgdxssxjmjslwzs.shtml'; '2021'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2021qgdxssxjmjslwzs/2021gjsbqgdxssxjmjslwzs.shtml'
}
$records = @()
foreach ($year in 2021..2025) {
  $y = [string]$year; $yd = Join-Path $out $y; New-Item -ItemType Directory -Force -Path $yd | Out-Null
  $page = Invoke-WebRequest -Uri ("https://www.mcm.edu.cn/html_cn/node/{0}.html" -f $nodes[$y]) -UseBasicParsing -TimeoutSec 60
  $pm = [regex]::Match($page.Content, 'href="(?<u>/upload_cn/node/[^"]+\.(?:zip|rar))"[^>]*>(?<n>[^<]+)')
  if (-not $pm.Success) { throw "未找到 $y 题目附件" }
  $problemUrl = 'https://www.mcm.edu.cn' + $pm.Groups['u'].Value; $problemName = $pm.Groups['n'].Value.Trim(); $problemPath = Join-Path $yd $problemName
  if (-not (Test-Path -LiteralPath $problemPath)) { Invoke-WebRequest -Uri $problemUrl -OutFile $problemPath -UseBasicParsing -TimeoutSec 180 }
  $idx = Invoke-WebRequest -Uri $paperIndex[$y] -UseBasicParsing -TimeoutSec 60
  $chosen = @{}
  $lm = [regex]::Matches($idx.Content, '(?is)<a[^>]+href=["''](?<u>[^"'']+)["''][^>]*>.*?(?<t>' + $y + '.*?题论文展示.*?)</a>')
  foreach ($m in $lm) { $title = [regex]::Replace($m.Groups['t'].Value, '<[^>]+>', '').Trim(); $q = [regex]::Match($title, '([A-E])题').Groups[1].Value; if ($q -and -not $chosen.ContainsKey($q)) { $chosen[$q] = [uri]::new([uri]$paperIndex[$y], $m.Groups['u'].Value).AbsoluteUri } }
  foreach ($q in 'A','B','C','D','E') {
    if (-not $chosen.ContainsKey($q)) { $records += [pscustomobject]@{Year=$y;Question=$q;Status='缺少官方展示页';Problem=$problemPath}; continue }
    $qd = Join-Path $yd ($q + '题'); New-Item -ItemType Directory -Force -Path $qd | Out-Null; $paperUrl = $chosen[$q]
    $detail = Invoke-WebRequest -Uri $paperUrl -UseBasicParsing -TimeoutSec 90; $n = 0
    $imgs = [regex]::Matches($detail.Content, '(?is)<img[^>]+src=["''](?<u>[^"'']+)["''][^>]*alt=["''](?<a>[^"'']*)["'']')
    foreach ($im in $imgs) { $iu = [uri]::new([uri]$paperUrl, $im.Groups['u'].Value).AbsoluteUri; if ($iu -notmatch '/upload/resources/(?:image|video)/' -and $im.Groups['a'].Value -notmatch '页面|page') { continue }; $n++; $ext = [IO.Path]::GetExtension(([uri]$iu).AbsolutePath); if ([string]::IsNullOrWhiteSpace($ext)) { $ext = '.jpg' }; $ip = Join-Path $qd ('论文页_{0:D3}{1}' -f $n,$ext); if (-not (Test-Path -LiteralPath $ip)) { try { Invoke-WebRequest -Uri $iu -OutFile $ip -UseBasicParsing -TimeoutSec 20 } catch { Remove-Item -LiteralPath $ip -Force -ErrorAction SilentlyContinue } } }
    $records += [pscustomobject]@{Year=$y;Question=$q;Status=$(if ($n -gt 0) {'已下载'} else {'论文页下载失败'});Problem=$problemPath;PaperUrl=$paperUrl;PaperPages=$n}
  }
}
$records | Export-Csv -LiteralPath (Join-Path $out '索引.csv') -NoTypeInformation -Encoding UTF8
@('# 全国大学生数学建模竞赛近五届组合包','',('生成日期: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),'范围: 2021-2025，每年 A-E 五道题。','', '说明: “优先论文”取中国大学生在线该年份该题官方展示列表中的首篇；官方页面未提供可验证的奖项等级字段，因此未将其表述为全国最高奖论文。论文以官网逐页图片原样保存。','', '来源:', '- 题目与附件: https://www.mcm.edu.cn/html_cn/block/8579f5fce999cdc896f78bca5d4f8237.html','- 论文展示: https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/qkt_sxjm_lw_lwzs.shtml','', '索引文件: 索引.csv') | Set-Content -LiteralPath (Join-Path $out 'README.md') -Encoding UTF8
Write-Output "OUT=$out"; $records | Group-Object Status | Select-Object Name,Count; Get-ChildItem -LiteralPath $out -Recurse -File | Measure-Object Length -Sum
