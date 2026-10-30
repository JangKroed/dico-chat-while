param([switch]$Doctor, [switch]$DryRun, [switch]$Install, [switch]$Open)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows 전용입니다. macOS는 setup.command를 사용하세요.' }
$ReadOnly = $Doctor -or $DryRun
$DicoNode = $null
$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($SystemNode) {
  & $SystemNode.Source -e 'process.exit(/^24\.(?:1[3-9]|[2-9][0-9])\./.test(process.versions.node)?0:1)'
  if ($LASTEXITCODE -eq 0) { $DicoNode = $SystemNode.Source }
}
$DicoDist = 'node-v24.13.0-win-x64'
$DicoCache = Join-Path $PSScriptRoot ".dico-tools\$DicoDist"
$CachedNode = Join-Path $DicoCache 'node.exe'
if (-not $DicoNode -and (Test-Path $CachedNode)) { $DicoNode = $CachedNode }
if (-not $DicoNode) {
  if ($ReadOnly) { throw 'Node 24.13.x가 없습니다. 진단/미리보기는 다운로드하지 않습니다. 옵션 없이 setup.ps1을 실행하면 로컬 도구를 준비합니다.' }
  $Tools = Join-Path $PSScriptRoot '.dico-tools'
  New-Item -ItemType Directory -Force $Tools | Out-Null
  $Temporary = Join-Path $Tools ('download-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $Temporary | Out-Null
  try {
    $Archive = "$DicoDist.zip"
    $Zip = Join-Path $Temporary $Archive
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v24.13.0/$Archive" -OutFile $Zip -TimeoutSec 600
    $Sums = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.13.0/SHASUMS256.txt' -TimeoutSec 60).Content
    $Pattern = '(?m)^([a-f0-9]{64})\s+' + [regex]::Escape($Archive) + '\r?$'
    $Match = [regex]::Match($Sums, $Pattern)
    if (-not $Match.Success -or (Get-FileHash $Zip -Algorithm SHA256).Hash -ine $Match.Groups[1].Value) { throw '공식 Node 체크섬이 일치하지 않습니다.' }
    Expand-Archive -LiteralPath $Zip -DestinationPath $Temporary
    if (Test-Path $DicoCache) { throw '다른 설정 작업에서 도구 폴더를 생성했습니다. 중복 실행을 종료한 뒤 재시도하세요.' }
    Move-Item -LiteralPath (Join-Path $Temporary $DicoDist) -Destination $DicoCache
    $DicoNode = $CachedNode
  } finally { Remove-Item -LiteralPath $Temporary -Recurse -Force }
}
& $DicoNode -e 'process.exit(/^24\.(?:1[3-9]|[2-9][0-9])\./.test(process.versions.node)?0:1)'
if ($LASTEXITCODE -ne 0) { throw 'Node 24.13 이상 24.x가 필요합니다.' }
$DicoArchitecture = & $DicoNode -p 'process.arch'
if ($LASTEXITCODE -ne 0 -or $DicoArchitecture -ne 'x64') { throw '현재 자동 설정은 Windows x64용입니다. Windows ARM은 실기기 검증 전입니다.' }
$env:PATH = (Split-Path -Parent $DicoNode) + [IO.Path]::PathSeparator + $env:PATH
if ($Doctor) { & $DicoNode (Join-Path $PSScriptRoot 'scripts\setup-central.mjs') --doctor; exit $LASTEXITCODE }
if ($DryRun) { & $DicoNode (Join-Path $PSScriptRoot 'scripts\setup-central.mjs') --install --open --dry-run; exit $LASTEXITCODE }
# Activate an already-installed compiler for this process only. Never install VS silently.
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $VsWhere) {
    $VsPath = & $VsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -eq 0 -and $VsPath) {
      $DevCmd = Join-Path ($VsPath | Select-Object -First 1) 'Common7\Tools\VsDevCmd.bat'
      if (Test-Path $DevCmd) {
        $CmdLine = '""' + $DevCmd + '" -arch=x64 -host_arch=x64 >nul && set"'
        $Lines = & cmd.exe /d /s /c $CmdLine
        if ($LASTEXITCODE -ne 0) { throw 'Visual Studio 빌드 환경을 활성화하지 못했습니다.' }
        foreach ($Line in $Lines) {
          if ($Line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
        }
      }
    }
  }
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  throw 'MSVC C++ 도구가 필요합니다. 설치 문서의 winget BuildTools 설치 후 setup.ps1을 다시 실행하세요. 시스템 도구는 자동 설치하지 않았습니다.'
}
& $DicoNode (Join-Path $PSScriptRoot 'scripts\setup-central.mjs') --install --open
exit $LASTEXITCODE
