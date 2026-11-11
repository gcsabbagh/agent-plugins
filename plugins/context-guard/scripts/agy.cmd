@echo off
rem context-guard launcher for agy on Windows: agy.cmd <script> [args].
rem agy runs commands through cmd, where `bash` is usually WSL's, so this runs
rem <script>.sh from this folder with Git Bash: CONTEXT_GUARD_BASH if set, else
rem %ProgramFiles%\Git, else the Git next to `git` on PATH. State (mode,
rem previous statusline) stays in %USERPROFILE%\.gemini\context-guard.
setlocal
set "CONTEXT_GUARD_DIR=%USERPROFILE%\.gemini\context-guard"
if defined CONTEXT_GUARD_BASH (
  set "GIT_BASH=%CONTEXT_GUARD_BASH%"
  goto run
)
set "GIT_BASH=%ProgramFiles%\Git\bin\bash.exe"
if exist "%GIT_BASH%" goto run
for /f "delims=" %%G in ('where git 2^>nul') do (
  set "GIT_BASH=%%~dpG..\bin\bash.exe"
  goto run
)
:run
if not exist "%GIT_BASH%" (
  if defined CONTEXT_GUARD_BASH (
    echo context-guard: CONTEXT_GUARD_BASH points to "%CONTEXT_GUARD_BASH%", which doesn't exist 1>&2
  ) else (
    echo context-guard: Git Bash not found; install Git for Windows or set CONTEXT_GUARD_BASH 1>&2
  )
  if /i "%~1"=="prompt-hook" echo {}
  exit /b 0
)
"%GIT_BASH%" "%~dp0%~1.sh" %2 %3 %4
exit /b 0
