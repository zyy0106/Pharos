$ErrorActionPreference='Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$out = Join-Path $desktop '全国大学生数学建模竞赛_2021-2025_题目-优先论文-附件'
$tmp=Join-Path $env:TEMP 'cumcm-paper-download'; New-Item -ItemType Directory -Force $tmp | Out-Null
$category=@{
'2025A'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2025qgdxssxjmjslwzs/2025atlw/';'2025B'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2025qgdxssxjmjslwzs/2025btlw/';'2025C'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2025qgdxssxjmjslwzs/2025ctlw/';'2025D'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2025qgdxssxjmjslwzs/2025dtlw/';'2025E'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2025qgdxssxjmjslwzs/2025etlw/';
'2024A'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2024qgdxssxjmjslwzs/2024atlw/';'2024B'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2024qgdxssxjmjslwzs/2024btlw/';'2024C'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2024qgdxssxjmjslwzs/2024ctlw/';'2024D'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2024qgdxssxjmjslwzs/2024dtlw/';'2024E'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2024qgdxssxjmjslwzs/2024etlw/';
'2023A'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2023qgdxssxjmjslwzs/2023atlw/';'2023B'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2023qgdxssxjmjslwzs/2023btlw/';'2023C'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2023qgdxssxjmjslwzs/2023ctlw/';'2023D'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2023qgdxssxjmjslwzs/2023dtlw/';'2023E'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2023qgdxssxjmjslwzs/2023etlw/';
'2022A'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2022qgdxssxjmjslwzs/2022atlw/';'2022B'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2022qgdxssxjmjslwzs/2022btlw/';'2022C'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2022qgdxssxjmjslwzs/2022ctlw/';'2022D'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2022qgdxssxjmjslwzs/2022dtlw/';'2022E'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2022qgdxssxjmjslwzs/2022etlw/';
'2021A'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2021qgdxssxjmjslwzs/2021atlw/';'2021B'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2021qgdxssxjmjslwzs/2021btlw/';'2021C'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2021qgdxssxjmjslwzs/2021ctlw/';'2021D'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2021qgdxssxjmjslwzs/2021dtlw/';'2021E'='https://dxs.moe.gov.cn/zx/hd/sxjm/sxjmlw/2021qgdxssxjmjslwzs/2021etlw/'
}
$rows=@()
foreach($key in $category.Keys){
  $year=$key.Substring(0,4);$q=$key.Substring(4,1);$qd=Join-Path $out (Join-Path $year ($q+'题'));New-Item -ItemType Directory -Force $qd|Out-Null
  $catFile=Join-Path $tmp ($key+'.html'); curl.exe -k -L --max-time 45 -A 'Mozilla/5.0' $category[$key] -o $catFile|Out-Null; $cat=Get-Content -Raw $catFile
  $pattern = '(?is)href=["''](?<u>(?:https?://dxs\.moe\.gov\.cn)?/zx/a/[^"'']+\.shtml)["''][^>]*>.*?title=["''](?<t>' + $year + '.*?题论文展示.*?)["'']'
  $links=[regex]::Matches($cat,$pattern) | Where-Object { $_.Groups['t'].Value -match $q } | ForEach-Object { $_.Groups['u'].Value } | Sort-Object -Unique
  $paperNo=0
  foreach($link in $links){
    if($link -notmatch 'https?://'){ $link='https://dxs.moe.gov.cn'+$link }
    $paperNo++;$paperDir=Join-Path (Join-Path $qd '论文文件') ('论文_{0:D2}' -f $paperNo);New-Item -ItemType Directory -Force $paperDir|Out-Null
    $detailFile=Join-Path $tmp ("$key`_$paperNo.html");curl.exe -k -L --max-time 45 -A 'Mozilla/5.0' $link -o $detailFile|Out-Null
    $detail=Get-Content -Raw $detailFile;$imgs=[regex]::Matches($detail,'(?is)<img[^>]+src=["''](?<u>[^"'']+)["''][^>]*alt=["''](?<a>[^"'']*)["'']')
    $pageNo=0
    foreach($im in $imgs){$iu=$im.Groups['u'].Value;if($iu -notmatch '/upload/resources/(?:image|video)/' -and $im.Groups['a'].Value -notmatch '页面|page'){continue};if($iu -notmatch '^https?://'){$iu=[uri]::new([uri]$link,$iu).AbsoluteUri};$pageNo++;$ext=[IO.Path]::GetExtension(([uri]$iu).AbsolutePath);if(!$ext){$ext='.jpg'};$dest=Join-Path $paperDir ('页面_{0:D3}{1}' -f $pageNo,$ext);if(!(Test-Path $dest)){curl.exe -k -L --retry 2 --max-time 45 -A 'Mozilla/5.0' $iu -o $dest|Out-Null}}
    $rows+=[pscustomobject]@{Year=$year;Question=$q;Paper=('论文_{0:D2}'-f $paperNo);PaperUrl=$link;ExpectedPages=$pageNo;DownloadedPages=(Get-ChildItem $paperDir -File -Include '*.jpg','*.jpeg','*.png'|Measure-Object).Count}
  }
}
$rows|Export-Csv (Join-Path $out '论文下载索引.csv') -NoTypeInformation -Encoding UTF8
$all=Get-ChildItem $out -Recurse -File;$m=$all|Measure-Object Length -Sum;Write-Output "PAPERS=$($rows.Count) FILES=$($m.Count) BYTES=$($m.Sum)";$rows|Group-Object Question|Select Name,Count
