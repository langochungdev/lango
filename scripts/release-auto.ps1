param(
  [ValidateSet("auto", "patch", "minor", "major")]
  [string]$Bump = "auto",
  [switch]$SkipBuildInstaller,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RootDir

function Require-GitRepository {
  $null = git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Git repository not found."
  }
}

function Get-LastTag {
  $tag = ""
  try {
    $tag = (git describe --tags --abbrev=0 2>$null).Trim()
  } catch {
    $tag = ""
  }
  return $tag
}

function Get-CommitSubjects {
  param([string]$Range)

  $raw = git log --reverse --pretty=format:%s $Range
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read git commits for range: $Range"
  }

  return @($raw -split "`n" | Where-Object { $_.Trim() -ne "" })
}

function Resolve-BumpLevel {
  param([string[]]$CommitSubjects)

  foreach ($subject in $CommitSubjects) {
    if ($subject -match "BREAKING CHANGE" -or $subject -match "!:") {
      return "major"
    }
  }

  foreach ($subject in $CommitSubjects) {
    if ($subject -match "^feat(\(.+\))?:") {
      return "minor"
    }
  }

  return "patch"
}

function Get-NextVersion {
  param(
    [string]$CurrentVersion,
    [string]$BumpLevel
  )

  if ($CurrentVersion -notmatch "^(\d+)\.(\d+)\.(\d+)$") {
    throw "Invalid current version format: $CurrentVersion"
  }

  $major = [int]$matches[1]
  $minor = [int]$matches[2]
  $patch = [int]$matches[3]

  switch ($BumpLevel) {
    "major" { $major += 1; $minor = 0; $patch = 0 }
    "minor" { $minor += 1; $patch = 0 }
    "patch" { $patch += 1 }
    default { throw "Unsupported bump level: $BumpLevel" }
  }

  return "$major.$minor.$patch"
}

function Replace-FirstRegex {
  param(
    [string]$FilePath,
    [string]$Pattern,
    [string]$Replacement,
    [switch]$Multiline
  )

  $content = Get-Content -Path $FilePath -Raw
  $options = [System.Text.RegularExpressions.RegexOptions]::None
  if ($Multiline) {
    $options = $options -bor [System.Text.RegularExpressions.RegexOptions]::Multiline
  }

  $regex = New-Object System.Text.RegularExpressions.Regex($Pattern, $options)
  $updated = $regex.Replace($content, $Replacement, 1)

  if ($updated -eq $content) {
    throw "Pattern not found in ${FilePath}: $Pattern"
  }

  Set-Content -Path $FilePath -Value $updated -NoNewline
}

function Update-VersionFiles {
  param([string]$Version)

  Replace-FirstRegex -FilePath (Join-Path $RootDir "package.json") -Pattern '"version"\s*:\s*"[^"]+"' -Replacement ('"version": "{0}"' -f $Version)
  Replace-FirstRegex -FilePath (Join-Path $RootDir "src-tauri/tauri.conf.json") -Pattern '"version"\s*:\s*"[^"]+"' -Replacement ('"version": "{0}"' -f $Version)
  Replace-FirstRegex -FilePath (Join-Path $RootDir "src-tauri/Cargo.toml") -Pattern '^version\s*=\s*"[^"]+"' -Replacement ('version = "{0}"' -f $Version) -Multiline
}

function Update-ChangelogFile {
  param(
    [string]$Version,
    [string[]]$CommitSubjects
  )

  $changelogPath = Join-Path $RootDir "CHANGELOG.md"
  $date = (Get-Date).ToString("yyyy-MM-dd")
  $entryLines = @("## v$Version - $date", "", "### Commits")

  foreach ($subject in $CommitSubjects) {
    $entryLines += "- $subject"
  }

  $entry = ($entryLines -join "`r`n") + "`r`n`r`n"

  if (Test-Path $changelogPath) {
    $old = Get-Content -Path $changelogPath -Raw
    if ($old -match '(?is)^\s*#\s*changelog\s*') {
      $rest = [System.Text.RegularExpressions.Regex]::Replace($old, '(?is)^\s*#\s*changelog\s*', '')
      $newContent = "# Changelog`r`n`r`n$entry$rest"
    } else {
      $newContent = "# Changelog`r`n`r`n$entry$old"
    }
  } else {
    $newContent = "# Changelog`r`n`r`n$entry"
  }

  Set-Content -Path $changelogPath -Value ($newContent.TrimEnd() + "`r`n")
}

Require-GitRepository

$packageJson = Get-Content -Path (Join-Path $RootDir "package.json") -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
if (-not $currentVersion) {
  throw "Cannot read current version from package.json"
}

$lastTag = Get-LastTag
$range = if ($lastTag) { "$lastTag..HEAD" } else { "HEAD" }
$commitSubjects = Get-CommitSubjects -Range $range

if ($commitSubjects.Count -eq 0) {
  Write-Host "No new commits to release."
  exit 0
}

$effectiveBump = if ($Bump -eq "auto") { Resolve-BumpLevel -CommitSubjects $commitSubjects } else { $Bump }
$nextVersion = Get-NextVersion -CurrentVersion $currentVersion -BumpLevel $effectiveBump

if ($DryRun) {
  Write-Host "Current version: $currentVersion"
  Write-Host "Next version: $nextVersion"
  Write-Host "Bump level: $effectiveBump"
  Write-Host "Commits counted: $($commitSubjects.Count)"
  exit 0
}

Update-VersionFiles -Version $nextVersion
Update-ChangelogFile -Version $nextVersion -CommitSubjects $commitSubjects

Write-Host "Updated version to $nextVersion"
Write-Host "Updated CHANGELOG.md"

if (-not $SkipBuildInstaller) {
  pnpm run build:installer:win
  if ($LASTEXITCODE -ne 0) {
    throw "Installer build failed with exit code $LASTEXITCODE"
  }
}

$installerPath = Join-Path $RootDir ("results/DictOver-{0}.exe" -f $nextVersion)
if (Test-Path $installerPath) {
  Write-Host "Installer ready: $installerPath"
} else {
  Write-Host "Installer not found yet at: $installerPath"
}
