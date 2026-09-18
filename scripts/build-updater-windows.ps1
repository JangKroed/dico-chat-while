$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$refs = @('/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll')
$sourcePath = Join-Path (Get-Location) 'updater\Windows.cs'
$testPath = Join-Path (Get-Location) 'tests\updater\WindowsTests.cs'
$binaryPath = Join-Path (Get-Location) 'dist\updater-windows\DICO-Updater.exe'
$testBinaryPath = Join-Path (Get-Location) 'dist\updater-windows\tests.exe'
New-Item -ItemType Directory -Force dist/updater-windows | Out-Null
& $csc /nologo /utf8output /codepage:65001 /target:exe "/out:$binaryPath" @refs "$sourcePath"
if ($LASTEXITCODE -ne 0) { throw 'Windows helper build failed' }
& $csc /nologo /utf8output /codepage:65001 /target:exe /main:UpdaterTests "/out:$testBinaryPath" @refs "$sourcePath" "$testPath"
if ($LASTEXITCODE -ne 0) { throw 'Windows test build failed' }
python tests/updater/fixtures.py dist/updater-windows/fixtures
if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed' }
& $testBinaryPath (Join-Path (Get-Location) 'dist\updater-windows\fixtures')
if ($LASTEXITCODE -ne 0) { throw 'Windows updater tests failed' }
Copy-Item updater/SETUP.md dist/updater-windows/SETUP.md
Compress-Archive -Force -Path dist/updater-windows/DICO-Updater.exe,dist/updater-windows/SETUP.md -DestinationPath dist/dico-updater-windows.zip
