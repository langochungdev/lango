!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM dictover-sidecar.exe'
  Pop $3
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Skip install ping when running updater-driven installation.
  StrCmp $UpdateMode 1 ping_done 0

  StrCpy $0 "$LOCALAPPDATA\\DictoverDesktop"
  StrCpy $1 "$0\\install-ping-success.flag"

  ; One-time ping marker: if already successful once, do not ping again.
  IfFileExists "$1" ping_done 0

  DetailPrint "Sending installation ping to langochung.me..."
  ExecWait "$\"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -ExecutionPolicy Bypass -Command $\"$$ErrorActionPreference = 'Stop'; $$stateDir = Join-Path $$env:LOCALAPPDATA 'DictoverDesktop'; New-Item -ItemType Directory -Force -Path $$stateDir | Out-Null; $$successFile = Join-Path $$stateDir 'install-ping-success.flag'; if (Test-Path $$successFile) { exit 0 }; $$url = 'https://langochung.me/api/ping/dictover-desktop'; $$appName = 'dictover-desktop'; $$installedAt = (Get-Date).ToUniversalTime().ToString('o'); $$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $$userName = $$env:USERNAME; $$body = @{ user_id = $$userSid; user_name = $$userName; app_name = $$appName; installed_at = $$installedAt } | ConvertTo-Json -Compress; $$ok = $$false; for ($$i = 0; $$i -lt 3 -and -not $$ok; $$i++) { try { Invoke-RestMethod -Method Post -Uri $$url -ContentType 'application/json' -Body $$body -TimeoutSec 10 | Out-Null; $$ok = $$true } catch { Start-Sleep -Seconds 2 } }; if ($$ok) { Set-Content -Path $$successFile -Value $$installedAt -Encoding UTF8; exit 0 }; exit 1$\"" $2

  StrCmp $2 0 ping_success ping_failed

  ping_success:
    DetailPrint "Install ping sent successfully."
    Goto ping_done

  ping_failed:
    DetailPrint "Install ping failed. Will retry on next install attempt."

  ping_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM dictover-sidecar.exe'
  Pop $3
  Sleep 500
!macroend
