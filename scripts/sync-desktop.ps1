# 把当前项目同步到桌面「学生网」副本
#
# 用法（项目根目录或任意位置）：
#   powershell -ExecutionPolicy Bypass -File scripts\sync-desktop.ps1
#
# 同步范围：服务端、页面、图片、脚本、部署文件
# 不同步：data\（桌面副本有自己的作品和帖子，不能被覆盖）
#         docs\、dist\（截图和安装包，不属于站点运行所需）

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
$dst = Join-Path ([Environment]::GetFolderPath('Desktop')) '学生网 无服务器'

if (-not (Test-Path $dst)) {
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
}

foreach ($file in @('server.js', 'README.md', 'Dockerfile', 'docker-compose.yml')) {
  $from = Join-Path $src $file
  if (Test-Path $from) {
    Copy-Item $from (Join-Path $dst $file) -Force
  }
}

# /MIR 会连删除一起同步，比如 public\img 里删掉的旧图
foreach ($dir in @('public', 'scripts', 'deploy')) {
  $from = Join-Path $src $dir
  if (Test-Path $from) {
    robocopy $from (Join-Path $dst $dir) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}

# data 只在副本没有时初始化，避免把副本自己的数据冲掉
$dstData = Join-Path $dst 'data'
if (-not (Test-Path $dstData)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dstData 'files') | Out-Null
  Copy-Item (Join-Path $src 'data\config.json') (Join-Path $dstData 'config.json') -Force
}

Write-Host "已同步到 $dst"
