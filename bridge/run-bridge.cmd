@echo off
set SOLIDWORKS_OUT_DIR=C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA
cd /d C:\Users\Carli\SolidworksIA
"C:\Program Files\dotnet\dotnet.exe" "C:\Users\Carli\SolidworksIA\bridge\bin\Release\net8.0-windows\swiax1uj.dll" > "%TEMP%\sw-bridge-out.log" 2> "%TEMP%\sw-bridge-err.log"
