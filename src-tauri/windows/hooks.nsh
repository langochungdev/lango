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
  CreateDirectory "$0"

  ; One-time ping marker: if already successful once, do not ping again.
  IfFileExists "$1" ping_done 0

  DetailPrint "Sending installation ping to langochung.me..."
  ExecWait "$\"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -ExecutionPolicy Bypass -Command $\"$$ErrorActionPreference='Stop';$$u='https://langochung.me/api/ping/dictover-desktop';$$t=(Get-Date).ToUniversalTime().ToString('o');$$b=@{user_id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;user_name=$$env:USERNAME;app_name='dictover-desktop';installed_at=$$t}|ConvertTo-Json -Compress;for($$i=0;$$i -lt 3;$$i++){try{irm -Method Post -Uri $$u -ContentType 'application/json' -Body $$b -TimeoutSec 10|Out-Null;Set-Content -Path '$1' -Value $$t -Encoding UTF8;exit 0}catch{Start-Sleep -Seconds 2}};exit 1$\"" $2

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
