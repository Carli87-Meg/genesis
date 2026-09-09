$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$env:SOLIDWORKS_BRIDGE_URL = "http://127.0.0.1:47821"
$env:SOLIDWORKS_OUT_DIR = "C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA"
New-Item -ItemType Directory -Force -Path @(
  "$env:SOLIDWORKS_OUT_DIR\CAD",
  "$env:SOLIDWORKS_OUT_DIR\Disegni",
  "$env:SOLIDWORKS_OUT_DIR\Export",
  "$env:SOLIDWORKS_OUT_DIR\Riferimenti"
) | Out-Null
if (-not (Test-Path "$root\.env.local")) {
  Copy-Item "$root\.env.example" "$root\.env.local"
}

Write-Host "Avvio bridge HTTP→COM su 127.0.0.1:47821"
dotnet build "$root\bridge\SolidWorksBridge.csproj" -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw "Build bridge fallita" }
$bridgeDll = "$root\bridge\bin\Release\net8.0-windows\swiax1u6.dll"
# AppLocker blocca l'apphost .exe. Smart App Control può bloccare un hash già visto:
# il primo `dotnet <nome>.dll` di un assembly nuovo è quello che passa; l'assembly attuale è swiax1u6.dll.
Start-Process -FilePath "dotnet" -ArgumentList @($bridgeDll) -WorkingDirectory $root

Start-Sleep -Seconds 3
Write-Host "Avvio app su 127.0.0.1:4317"
npm run dev
