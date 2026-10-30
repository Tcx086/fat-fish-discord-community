@echo off
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0tools\windows\FatFish.ps1" -Action Start
pause
