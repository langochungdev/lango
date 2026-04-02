$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$PythonBin = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { "python" }
$SidecarPort = if ($env:SIDECAR_PORT) { $env:SIDECAR_PORT } else { "49152" }
$PackageManager = if ($env:DICTOVER_PACKAGE_MANAGER) {
  $env:DICTOVER_PACKAGE_MANAGER
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  "pnpm"
} else {
  "npm"
}
$OcrFontName = "NotoSansCJK-Regular.ttc"
$BundledOcrFontPath = Join-Path $RootDir "src-tauri/binaries/$OcrFontName"

$sidecarProc = $null
$sidecarStartedByScript = $false

function Ensure-OcrFontResource {
  if (Test-Path $BundledOcrFontPath) {
    return
  }

  New-Item -ItemType Directory -Path (Split-Path $BundledOcrFontPath -Parent) -Force | Out-Null

  $candidates = @()
  if ($env:DICTOVER_OCR_FONT_SOURCE) {
    $candidates += $env:DICTOVER_OCR_FONT_SOURCE
  }
  $candidates += (Join-Path $RootDir "sidecar/fonts/$OcrFontName")
  $candidates += "C:\Windows\Fonts\NotoSansCJK-Regular.ttc"
  $candidates += "C:\Windows\Fonts\arial.ttf"

  $source = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $source) {
    throw @"
Khong tim thay file font OCR bat buoc cho Tauri resource: $OcrFontName

Hay dat font tai sidecar/fonts/$OcrFontName
hoac set bien moi truong DICTOVER_OCR_FONT_SOURCE tro den file font truoc khi chay:
npm run dev:desktop:win
"@
  }

  Copy-Item -Path $source -Destination $BundledOcrFontPath -Force
  Write-Host "  OCR font resource ready: $BundledOcrFontPath"
}

function Test-PortInUse {
  param([int]$Port)

  try {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    return $listeners.Count -gt 0
  }
  catch {
    return $false
  }
}

function Test-PortBindable {
  param([int]$Port)

  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  }
  catch {
    return $false
  }
  finally {
    if ($null -ne $listener) {
      try {
        $listener.Stop()
      }
      catch {
      }
    }
  }
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return $listener.LocalEndpoint.Port
  }
  finally {
    $listener.Stop()
  }
}

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

  $effectiveSidecarPort = [int]$SidecarPort
  if (Test-PortInUse -Port $effectiveSidecarPort) {
    Write-Host "  Port $SidecarPort dang duoc su dung, se tai su dung sidecar hien co."
  }
  else {
    if (-not (Test-PortBindable -Port $effectiveSidecarPort)) {
      $effectiveSidecarPort = Get-FreeTcpPort
      Write-Host "  Port $SidecarPort khong bind duoc, chuyen sang port $effectiveSidecarPort."
    }

    $sidecarProc = Start-Process -FilePath $PythonBin -ArgumentList @("-m", "uvicorn", "main:app", "--port", "$effectiveSidecarPort", "--reload") -PassThru -NoNewWindow
    $sidecarStartedByScript = $true
  }

  Write-Host "[2/4] Install frontend deps"
  Set-Location $RootDir
  if ($PackageManager -eq "pnpm") {
    pnpm install
  }
  else {
    npm install
  }

  Write-Host "[3/4] Ensure OCR font resource"
  Ensure-OcrFontResource

  Write-Host "[4/4] Start Tauri dev"
  $env:SIDECAR_PORT = "$effectiveSidecarPort"
  $env:DICTOVER_ENABLE_DEBUG_TRACE = "1"
  $env:VITE_DEBUG_TRACE = "1"
  if ($PackageManager -eq "pnpm") {
    pnpm run tauri dev
  }
  else {
    npm run tauri dev
  }
}
finally {
  if ($sidecarStartedByScript -and $null -ne $sidecarProc -and -not $sidecarProc.HasExited) {
    Stop-Process -Id $sidecarProc.Id -Force
  }
}
