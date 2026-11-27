@echo off
setlocal
set "arch=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "arch=arm64"
set "exe=%~dp0..\vendor\win32-%arch%\memorylake.exe"
if not exist "%exe%" set "exe=%~dp0..\vendor\win32-x64\memorylake.exe"
if not exist "%exe%" set "exe=%USERPROFILE%\.memorylake\bin\memorylake.exe"
if not exist "%exe%" (
  echo memorylake: this copy of the MemoryLake plugin has no CLI for win32-%arch% 1>&2
  exit /b 127
)
"%exe%" %*
exit /b %ERRORLEVEL%
