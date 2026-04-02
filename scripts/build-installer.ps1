param(
  [string]$TargetTriple = "x86_64-pc-windows-msvc",
  [switch]$Full
)

$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$DefaultPython = Join-Path $RootDir ".venv/Scripts/python.exe"
$PythonBin = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } elseif (Test-Path $DefaultPython) { $DefaultPython } else { "python" }
$PackageManager = if ($env:DICTOVER_PACKAGE_MANAGER) {
  $env:DICTOVER_PACKAGE_MANAGER
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  "pnpm"
} else {
  "npm"
}
$QuickMode = -not $Full
$StepTimes = [ordered]@{}
$TotalTimer = [System.Diagnostics.Stopwatch]::StartNew()
$CacheDir = Join-Path $RootDir "src-tauri/binaries/.build-cache"
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null

function Remove-GitUsrBinFromPath {
  $entries = $env:Path -split ";"
  $cleaned = $entries | Where-Object { $_ -and ($_ -notmatch "(?i)\\Git\\usr\\bin\\?") }
  $env:Path = ($cleaned -join ";")
}

function Import-VsDevEnvironment {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { return $false }

  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $installPath) { return $false }

  $vcvars = Join-Path $installPath "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcvars)) { return $false }

  $envDump = cmd.exe /s /c "`"$vcvars`" >nul && set"
  foreach ($line in $envDump) {
    if ($line -notmatch "=") { continue }
    $idx = $line.IndexOf("=")
    if ($idx -le 0) { continue }
    [Environment]::SetEnvironmentVariable($line.Substring(0, $idx), $line.Substring($idx + 1), "Process")
  }

  return $true
}

function Assert-TauriWindowsToolchain {
  Remove-GitUsrBinFromPath
  $null = Import-VsDevEnvironment

  $linkCmd = Get-Command link.exe -ErrorAction SilentlyContinue
  if ($null -eq $linkCmd) {
    throw "Khong tim thay Microsoft linker (link.exe). Cai Visual Studio Build Tools voi Desktop development with C++ roi chay lai."
  }

  $clCmd = Get-Command cl.exe -ErrorAction SilentlyContinue
  if ($null -eq $clCmd) {
    throw "Khong tim thay cl.exe (MSVC compiler). Mo terminal PowerShell moi va chay lai script."
  }

  if ($linkCmd.Source -match "(?i)\\Git\\usr\\bin\\link\.exe$") {
    throw "Dang dung nham link.exe cua Git. Hay mo PowerShell (khong dung Git Bash) roi chay lai script."
  }
}

function Get-FileHashSafe {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Get-StampValue {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  return (Get-Content -Path $Path -Raw).Trim()
}

function Set-StampValue {
  param([string]$Path, [string]$Value)
  Set-Content -Path $Path -Value $Value -NoNewline
}

function Get-SidecarFingerprint {
  param([string]$SidecarDir)

  $root = (Resolve-Path $SidecarDir).Path
  $files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
    $_.FullName -notmatch "\\(__pycache__|build|dist|\.pytest_cache)\\" -and
    $_.Name -ne "dictover-sidecar.spec" -and
    $_.Extension -ne ".pyc"
  } | Sort-Object FullName

  $builder = New-Object System.Text.StringBuilder
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length).TrimStart([char[]]@([char]92, [char]47))
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file.FullName).Hash.ToLower()
    [void]$builder.Append($relative).Append("|").Append($hash).Append("`n")
  }

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($bytes)
  }
  finally {
    $sha.Dispose()
  }

  return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLower()
}

function Resolve-NsisBundleDir {
  $targetBundle = Join-Path $RootDir "src-tauri/target/$TargetTriple/release/bundle/nsis"
  if (Test-Path $targetBundle) {
    return $targetBundle
  }

  return (Join-Path $RootDir "src-tauri/target/release/bundle/nsis")
}

function Run-Step {
  param([string]$Name, [scriptblock]$Action)

  Write-Host "[$($StepTimes.Count + 1)] $Name"
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  & $Action
  $timer.Stop()
  $StepTimes[$Name] = $timer.Elapsed.TotalSeconds
}

Set-Location $RootDir
Assert-TauriWindowsToolchain

$NpmLockPath = Join-Path $RootDir "package-lock.json"
$NpmLockStampPath = Join-Path $CacheDir "package-lock.sha256"
$ReqPath = Join-Path $RootDir "sidecar/requirements.txt"
$ReqStampPath = Join-Path $CacheDir "sidecar-requirements.sha256"
$SidecarSourceStampPath = Join-Path $CacheDir "sidecar-source.sha256"
$SidecarExe = Join-Path $RootDir "src-tauri/binaries/dictover-sidecar.exe"
$InstallerOutputDir = Join-Path $RootDir "results"
$TauriConfigPath = Join-Path $RootDir "src-tauri/tauri.conf.json"
$OcrFontName = "NotoSansCJK-Regular.ttc"
$BundledOcrFontPath = Join-Path $RootDir "src-tauri/binaries/$OcrFontName"
$DefaultOcrFontSourcePath = Join-Path $RootDir "sidecar/fonts/$OcrFontName"
$TauriIconIcoPath = Join-Path $RootDir "src-tauri/icons/icon.ico"
$TauriIconIcnsPath = Join-Path $RootDir "src-tauri/icons/icon.icns"
$TauriIconPngPath = Join-Path $RootDir "src-tauri/icons/icon.png"

if (-not (Test-Path $TauriConfigPath)) {
  throw "Khong tim thay tauri config: $TauriConfigPath"
}

$TauriConfig = Get-Content -Path $TauriConfigPath -Raw | ConvertFrom-Json
$AppVersion = $TauriConfig.version
if (-not $AppVersion) {
  throw "Khong doc duoc version tu $TauriConfigPath"
}

$CanonicalInstallerName = "DictOver-$AppVersion.exe"

Run-Step "Validate Tauri bundle icons" {
  $missing = @()
  foreach ($path in @($TauriIconIcoPath, $TauriIconIcnsPath, $TauriIconPngPath)) {
    if (-not (Test-Path $path)) {
      $missing += $path
    }
  }

  if ($missing.Count -gt 0) {
    throw "Thieu icon bundle Tauri: $($missing -join ', '). Chay 'npm run tauri icon <source.png>' de tao lai icon truoc khi build."
  }

  Write-Host "  Icon bundle ready: $TauriIconIcoPath"
}

Run-Step "Install frontend dependencies (if lockfile changed)" {
  $currentLockHash = Get-FileHashSafe -Path $NpmLockPath
  $savedLockHash = Get-StampValue -Path $NpmLockStampPath
  $mustInstall = (-not $QuickMode) -or ($currentLockHash -ne $savedLockHash) -or (-not (Test-Path (Join-Path $RootDir "node_modules")))

  if ($mustInstall) {
    if ($PackageManager -eq "pnpm") {
      pnpm install
    }
    else {
      npm install
    }
    if ($currentLockHash) {
      Set-StampValue -Path $NpmLockStampPath -Value $currentLockHash
    }
  } else {
    Write-Host "  Skip npm install (lockfile unchanged)."
  }
}

Run-Step "Install sidecar Python dependencies (if requirements changed)" {
  $currentReqHash = Get-FileHashSafe -Path $ReqPath
  $savedReqHash = Get-StampValue -Path $ReqStampPath

  $pyInstallerReady = $false
  try {
    & $PythonBin -m PyInstaller --version *> $null
    $pyInstallerReady = $LASTEXITCODE -eq 0
  } catch {
    $pyInstallerReady = $false
  }

  $mustInstall = (-not $QuickMode) -or ($currentReqHash -ne $savedReqHash) -or (-not $pyInstallerReady)

  if ($mustInstall) {
    & $PythonBin -m pip install -r sidecar/requirements.txt
    & $PythonBin -m pip install pyinstaller
    if ($currentReqHash) {
      Set-StampValue -Path $ReqStampPath -Value $currentReqHash
    }
  } else {
    Write-Host "  Skip pip install (requirements unchanged)."
  }
}

Run-Step "Ensure OCR font resource is bundled" {
  if (Test-Path $BundledOcrFontPath) {
    $fontSizeMb = [Math]::Round(((Get-Item $BundledOcrFontPath).Length / 1MB), 2)
    Write-Host "  OCR font ready: $BundledOcrFontPath ($fontSizeMb MB)"
    return
  }

  $fontSource = ""
  if ($env:DICTOVER_OCR_FONT_SOURCE -and (Test-Path $env:DICTOVER_OCR_FONT_SOURCE)) {
    $fontSource = $env:DICTOVER_OCR_FONT_SOURCE
  } elseif (Test-Path $DefaultOcrFontSourcePath) {
    $fontSource = $DefaultOcrFontSourcePath
  }

  if (-not $fontSource) {
    throw "Khong tim thay $OcrFontName. Dat file tai sidecar/fonts/$OcrFontName hoac set env DICTOVER_OCR_FONT_SOURCE truoc khi build installer."
  }

  Copy-Item -Path $fontSource -Destination $BundledOcrFontPath -Force
  $fontSizeMb = [Math]::Round(((Get-Item $BundledOcrFontPath).Length / 1MB), 2)
  Write-Host "  Copied OCR font: $BundledOcrFontPath ($fontSizeMb MB)"
}

Run-Step "Build sidecar executable (if sidecar source changed)" {
  $sidecarFingerprint = Get-SidecarFingerprint -SidecarDir (Join-Path $RootDir "sidecar")
  $savedFingerprint = Get-StampValue -Path $SidecarSourceStampPath
  $mustRebuild = (-not $QuickMode) -or (-not (Test-Path $SidecarExe)) -or ($sidecarFingerprint -ne $savedFingerprint)

  if ($mustRebuild) {
    Set-Location (Join-Path $RootDir "sidecar")
    & $PythonBin -m PyInstaller --noconfirm main.py --onefile --name dictover-sidecar --distpath ../src-tauri/binaries/
    Set-Location $RootDir

    if (-not (Test-Path $SidecarExe)) {
      throw "Khong tao duoc sidecar executable: $SidecarExe"
    }

    Set-StampValue -Path $SidecarSourceStampPath -Value $sidecarFingerprint
  } else {
    Write-Host "  Skip sidecar build (source unchanged)."
  }
}

Run-Step "Clean previous installer executables" {
  New-Item -ItemType Directory -Path $InstallerOutputDir -Force | Out-Null

  $oldResultInstallers = Get-ChildItem -Path $InstallerOutputDir -File -Filter "*.exe" -ErrorAction SilentlyContinue
  if ($oldResultInstallers) {
    $removed = 0
    $skipped = 0
    foreach ($oldInstaller in $oldResultInstallers) {
      try {
        Remove-Item -Path $oldInstaller.FullName -Force -ErrorAction Stop
        $removed += 1
      } catch {
        $skipped += 1
        Write-Host "  Skip locked installer: $($oldInstaller.FullName)"
      }
    }
    Write-Host "  Removed $removed old installer(s) from $InstallerOutputDir"
    if ($skipped -gt 0) {
      Write-Host "  Skipped $skipped locked installer(s) in $InstallerOutputDir"
    }
  } else {
    Write-Host "  No old installers found in $InstallerOutputDir"
  }

  $bundleRoot = Resolve-NsisBundleDir
  if (Test-Path $bundleRoot) {
    $oldBundleInstallers = Get-ChildItem -Path $bundleRoot -Recurse -File | Where-Object { $_.Extension -ieq ".exe" }
    if ($oldBundleInstallers) {
      $removedBundle = 0
      foreach ($oldBundleInstaller in $oldBundleInstallers) {
        try {
          Remove-Item -Path $oldBundleInstaller.FullName -Force -ErrorAction Stop
          $removedBundle += 1
        } catch {
          Write-Host "  Skip locked bundle exe: $($oldBundleInstaller.FullName)"
        }
      }
      Write-Host "  Removed $removedBundle stale bundle exe(s) from $bundleRoot"
    }
  }
}

Run-Step "Build Windows installer (NSIS .exe only)" {
  if ($PackageManager -eq "pnpm") {
    pnpm run tauri build -- --target $TargetTriple --bundles nsis
    if ($LASTEXITCODE -ne 0) {
      throw "Tauri NSIS build failed with exit code $LASTEXITCODE"
    }
  }
  else {
    npm run tauri build -- --target $TargetTriple --bundles nsis
    if ($LASTEXITCODE -ne 0) {
      throw "Tauri NSIS build failed with exit code $LASTEXITCODE"
    }
  }
}

Run-Step "Collect installer artifacts" {
  $bundleRoot = Resolve-NsisBundleDir
  if (-not (Test-Path $bundleRoot)) {
    throw "Khong tim thay thu muc NSIS bundle: $bundleRoot"
  }

  $installers = Get-ChildItem -Path $bundleRoot -Recurse -File | Where-Object { $_.Extension -eq ".exe" }
  if (-not $installers) {
    throw "Khong tim thay file installer .exe trong $bundleRoot"
  }

  $installer = $installers | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $canonicalBundlePath = Join-Path $bundleRoot $CanonicalInstallerName

  if ($installer.FullName -ne $canonicalBundlePath) {
    if (Test-Path $canonicalBundlePath) {
      Remove-Item -Path $canonicalBundlePath -Force -ErrorAction SilentlyContinue
    }
    Move-Item -Path $installer.FullName -Destination $canonicalBundlePath -Force
  }

  $destination = Join-Path $InstallerOutputDir $CanonicalInstallerName
  Copy-Item -Path $canonicalBundlePath -Destination $destination -Force

  Write-Host ""
  Write-Host "Installer build thanh cong. File tao ra trong results:"
  Write-Host " - $destination"
}

$TotalTimer.Stop()
Write-Host ""
Write-Host "Timing summary (seconds):"
foreach ($item in $StepTimes.GetEnumerator()) {
  Write-Host (" - {0}: {1:N1}s" -f $item.Key, $item.Value)
}
Write-Host (" - Total: {0:N1}s" -f $TotalTimer.Elapsed.TotalSeconds)
