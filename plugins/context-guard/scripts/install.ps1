# context-guard installer for PowerShell (Windows PowerShell 5.1 or PowerShell 7,
# on Windows, macOS or Linux). Runs install.sh with the right bash and passes
# its arguments through: install.ps1 [--agy | --claude] [--quiet]
# On Windows, `bash` is usually WSL's, which would install into WSL, so this
# uses Git Bash: CONTEXT_GUARD_BASH if set, else %ProgramFiles%\Git, else the
# Git next to `git` on PATH (the same order as agy.cmd).
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  [Console]::Error.WriteLine("context-guard: $message")
  exit 1
}

function Find-GitBash {
  if ($env:CONTEXT_GUARD_BASH) {
    if (Test-Path -LiteralPath $env:CONTEXT_GUARD_BASH -PathType Leaf) { return $env:CONTEXT_GUARD_BASH }
    Fail "CONTEXT_GUARD_BASH points to '$env:CONTEXT_GUARD_BASH', which doesn't exist."
  }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Git\bin\bash.exe' }
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($git) { $candidates += Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe' }
  $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

# $IsWindows only exists in PowerShell 6+.
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
if ($onWindows) {
  $bash = Find-GitBash
  if (-not $bash) { Fail 'Git Bash not found. Install Git for Windows (winget install Git.Git) or set CONTEXT_GUARD_BASH to its bash.exe.' }
} else {
  $bash = 'bash'
}

# Forward slashes: install.sh finds its folder with dirname, which doesn't split
# backslash paths.
$installSh = (Join-Path $PSScriptRoot 'install.sh') -replace '\\', '/'
& $bash $installSh @args
exit $LASTEXITCODE
