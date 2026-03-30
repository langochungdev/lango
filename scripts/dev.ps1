$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$PythonBin = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { "python" }
$SidecarPort = if ($env:SIDECAR_PORT) { $env:SIDECAR_PORT } else { "49152" }

$sidecarProc = $null

function Remove-GitUsrBinFromPath {
  $entries = $env:Path -split ";"
  $cleaned = $entries | Where-Object { $_ -and ($_ -notmatch "(?i)\\Git\\usr\\bin\\?") }
  $env:Path = ($cleaned -join ";")
}

function Import-VsDevEnvironment {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    return $false
  }

  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $installPath) {
    return $false
  }

  $vcvars = Join-Path $installPath "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcvars)) {
    return $false
  }

  $cmdLine = "`"$vcvars`" >nul && set"
  $envDump = cmd.exe /s /c $cmdLine
  foreach ($line in $envDump) {
    if ($line -notmatch "=") {
      continue
    }

    $idx = $line.IndexOf("=")
    if ($idx -le 0) {
      continue
    }

    $name = $line.Substring(0, $idx)
    $value = $line.Substring($idx + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }

  return $true
}

function Assert-TauriWindowsToolchain {
  Remove-GitUsrBinFromPath
  $null = Import-VsDevEnvironment

  $linkCmd = Get-Command link.exe -ErrorAction SilentlyContinue
  if ($null -eq $linkCmd) {
    throw @"
Khong tim thay Microsoft linker (link.exe).

Ban can cai Visual Studio Build Tools voi workload "Desktop development with C++"
bao gom MSVC va Windows SDK, sau do mo terminal moi roi chay lai:
npm run dev:desktop:win
"@
  }

  $clCmd = Get-Command cl.exe -ErrorAction SilentlyContinue
  if ($null -eq $clCmd) {
    throw @"
Khong tim thay cl.exe (MSVC compiler) sau khi nap moi truong Visual C++.

Hay dong terminal hien tai, mo PowerShell moi, roi chay lai:
npm run dev:desktop:win
"@
  }

  if ($linkCmd.Source -match "(?i)\\Git\\usr\\bin\\link\.exe$") {
    throw @"
Dang dung nham link.exe cua Git tai:
$($linkCmd.Source)

Script da co gang loai bo Git/usr/bin khoi PATH nhung van trung xung dot.
Hay mo terminal PowerShell moi (khong dung Git Bash), sau do chay lai:
npm run dev:desktop:win
"@
  }

  $winsdkLibRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Lib"
  if (-not (Test-Path $winsdkLibRoot)) {
    throw @"
Khong tim thay Windows SDK libraries ($winsdkLibRoot).

Vui long cai Visual Studio Build Tools (Desktop development with C++)
de co cac file nhu kernel32.lib, userenv.lib.
"@
  }
}

try {
  Assert-TauriWindowsToolchain

  Write-Host "[1/3] Start Python sidecar"
  Set-Location (Join-Path $RootDir "sidecar")
  & $PythonBin -m pip install -r requirements.txt
  $sidecarProc = Start-Process -FilePath $PythonBin -ArgumentList @("-m", "uvicorn", "main:app", "--port", $SidecarPort, "--reload") -PassThru -NoNewWindow

  Write-Host "[2/3] Install frontend deps"
  Set-Location $RootDir
  npm install

  Write-Host "[3/3] Start Tauri dev"
  $env:SIDECAR_PORT = $SidecarPort
  npm run tauri dev
}
finally {
  if ($null -ne $sidecarProc -and -not $sidecarProc.HasExited) {
    Stop-Process -Id $sidecarProc.Id -Force
  }
}
