# context-guard

## 1.1.1

### Patch Changes

- 167b6d7: Fix the installer on macOS. Its bash 3.2 wrote the status line command as `bash \~/...`, which doesn't run. Run the installer again to fix an existing install.
- 5546617: Install context-guard with one command, without cloning the repo. The command downloads the latest release and runs its installer with your options:
  
  ```
  curl -fsSL https://raw.githubusercontent.com/gcsabbagh/agent-plugins/main/plugins/context-guard/scripts/get.sh | bash -s -- --agy
  ```
  
  From PowerShell:
  
  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/gcsabbagh/agent-plugins/main/plugins/context-guard/scripts/get.ps1))) --agy
  ```
  
  Add `--version X.Y.Z` to install a specific release, or `--agy-plugin` to install it as an agy plugin.

## 1.1.0

First release: a status line and a `/compact` nudge for agy and Claude Code. See the [release notes](https://github.com/gcsabbagh/agent-plugins/releases/tag/context-guard%401.1.0).
