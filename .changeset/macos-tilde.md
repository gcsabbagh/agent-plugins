---
"context-guard": patch
---

Fix the installer on macOS. Its bash 3.2 wrote the status line command as `bash \~/...`, which doesn't run. Run the installer again to fix an existing install.
