$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$env:SOLIDWORKS_BRIDGE_URL = "http://127.0.0.1:47821"
if (-not (Test-Path "$root\.env.local")) {
  Copy-Item "$root\.env.example" "$root\.env.local"
}

Write-Host "Avvio bridge HTTP→COM su 127.0.0.1:47821"
Start-Process -FilePath "dotnet" -ArgumentList @(
  "run", "--project", "$root\bridge\SolidWorksBridge.csproj", "-c", "Release", "--no-launch-profile"
) -WorkingDirectory $root

Start-Sleep -Seconds 3
Write-Host "Avvio app su 127.0.0.1:4317"
npm run dev
