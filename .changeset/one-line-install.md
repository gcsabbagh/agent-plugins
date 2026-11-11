---
"context-guard": patch
---

Install context-guard with one command, without cloning the repo. The command downloads the latest release and runs its installer with your options:

```
curl -fsSL https://raw.githubusercontent.com/gcsabbagh/agent-plugins/main/plugins/context-guard/scripts/get.sh | bash -s -- --agy
```

From PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/gcsabbagh/agent-plugins/main/plugins/context-guard/scripts/get.ps1))) --agy
```

Add `--version X.Y.Z` to install a specific release, or `--agy-plugin` to install it as an agy plugin.
