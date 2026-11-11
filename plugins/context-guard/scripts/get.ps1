# context-guard one-line installer for PowerShell (Windows PowerShell 5.1 or
# PowerShell 7): downloads a context-guard release from GitHub and runs its
# install.ps1, with no clone.
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/gcsabbagh/agent-plugins/main/plugins/context-guard/scripts/get.ps1))) --agy
# Usage: get.ps1 [--version X.Y.Z] [--agy-plugin] [install.ps1 options]
#   --version     install that release instead of the latest one
#   --agy-plugin  install it as an agy plugin (agy plugin install), then run the
#                 installer from the installed plugin, which implies --agy
# Everything else goes to install.ps1 (--agy, --claude, --nudge-only).

function Invoke-ContextGuardGet([object[]]$argv) {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far slower with the progress bar
  # Windows PowerShell 5.1 may not offer TLS 1.2 by default, which GitHub requires.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = if ($env:CONTEXT_GUARD_REPO) { $env:CONTEXT_GUARD_REPO } else { 'gcsabbagh/agent-plugins' }
  # Overridable so the tests can serve releases locally.
  $releasesUrl = if ($env:CONTEXT_GUARD_RELEASES_URL) { $env:CONTEXT_GUARD_RELEASES_URL } else { "https://api.github.com/repos/$repo/releases?per_page=100" }
  $archiveBase = if ($env:CONTEXT_GUARD_ARCHIVE_BASE) { $env:CONTEXT_GUARD_ARCHIVE_BASE } else { "https://github.com/$repo/archive/refs/tags" }

  $version = $null; $agyPlugin = $false; $rest = @()
  for ($i = 0; $i -lt $argv.Count; $i++) {
    $a = [string]$argv[$i]
    if ($a -eq '--version') {
      if ($i + 1 -ge $argv.Count) { throw '--version needs a version, e.g. --version 1.1.0' }
      $i++; $version = [string]$argv[$i]
    } elseif ($a -like '--version=*') { $version = $a.Substring(10) }
    elseif ($a -eq '--agy-plugin') { $agyPlugin = $true }
    else { $rest += $a }
  }

  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'tar is required (it ships with Windows 10 and later).' }

  if ($version) {
    $tag = "context-guard@$version"
  } else {
    # The repo's "latest release" may be another plugin's, so pick the newest
    # published context-guard@ release.
    try { $releases = Invoke-RestMethod -Uri $releasesUrl -UseBasicParsing } catch { throw "couldn't list releases from ${releasesUrl}: $($_.Exception.Message)" }
    $tag = $null
    # foreach, not the pipeline: 5.1 passes a JSON array down it as one object.
    foreach ($r in $releases) {
      if ("$($r.tag_name)".StartsWith('context-guard@') -and -not $r.draft -and -not $r.prerelease) { $tag = $r.tag_name; break }
    }
    if (-not $tag) { throw "no context-guard release found at $releasesUrl" }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("context-guard-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path (Join-Path $tmp 'src') | Out-Null
  try {
    [Console]::Error.WriteLine("context-guard: downloading $tag")
    $archive = Join-Path $tmp 'src.tar.gz'
    try { Invoke-WebRequest -Uri "$archiveBase/$tag.tar.gz" -OutFile $archive -UseBasicParsing } catch { throw "couldn't download $tag from ${archiveBase}: $($_.Exception.Message)" }
    Push-Location $tmp
    try { & tar -xzf src.tar.gz --strip-components=1 -C src | Out-Host } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "couldn't unpack $tag" }
    $plugin = Join-Path $tmp 'src/plugins/context-guard'
    if (-not (Test-Path -LiteralPath (Join-Path $plugin 'scripts/install.ps1'))) { throw "$tag has no plugins/context-guard/scripts/install.ps1" }

    if ($agyPlugin) {
      if (-not (Get-Command agy -ErrorAction SilentlyContinue)) { throw 'agy not found on PATH, which --agy-plugin needs.' }
      & agy plugin install $plugin | Out-Host
      if ($LASTEXITCODE -ne 0) { throw 'agy plugin install failed' }
      # Git Bash's home, which install.sh uses: HOME if set, else USERPROFILE.
      $userHome = if ($env:HOME) { $env:HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
      & (Join-Path $userHome '.gemini/config/plugins/context-guard/scripts/install.ps1') --agy @rest | Out-Host
      return $LASTEXITCODE
    }
    # Out-Host: inside a function, output would otherwise become the return value.
    & (Join-Path $plugin 'scripts/install.ps1') @rest | Out-Host
    $code = $LASTEXITCODE
    if ($code -eq 0 -and $rest -notcontains '--agy') {
      [Console]::Error.WriteLine("context-guard: in Claude Code the nudge hook comes with the plugin: /plugin marketplace add $repo, then /plugin install context-guard@gcsabbagh-agent-plugins")
    }
    return $code
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try { $code = Invoke-ContextGuardGet $args } catch { [Console]::Error.WriteLine("context-guard: $($_.Exception.Message)"); $code = 1 }
# Run as a file, exit with the code. Run as a script block (the irm one-liner),
# `exit` would close the user's PowerShell, so leave it in $LASTEXITCODE.
if ($MyInvocation.MyCommand.Path) { exit $code } else { $global:LASTEXITCODE = $code }
