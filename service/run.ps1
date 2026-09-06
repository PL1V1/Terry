<#
.SYNOPSIS
  Launches Terry as a scheduled task.

.DESCRIPTION
  Sets the working directory (which is how bun finds .env), tells the service
  where to write its log, and starts it.

  The service writes its own log file rather than being redirected into one.
  Redirecting through the launcher meant the file handle belonged to a wrapper
  that could outlive the service, or be killed while the service survived -
  either way the next start could not open the file, and the service failed for
  a reason that had nothing to do with the service.

  It refuses to start a second instance, using an exclusively held lock file.
  Two clients on one bot token fight over the presence indicator, and the task's
  own MultipleInstances setting does not cover a process orphaned from an
  earlier run.

  It also reports its own failures. A launcher that dies silently is
  indistinguishable from a service that will not start, and under a scheduled
  task there is no console to print to.

  Old logs are pruned so an unattended service cannot slowly fill the disk.
#>
[CmdletBinding()]
param(
  [int]$KeepDays = 14
)

$ErrorActionPreference = "Stop"

# Resolved before anything can fail, so a startup error always has somewhere to
# go. $PSScriptRoot is not reliably populated in every invocation form.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectDir = if ($scriptDir) { Split-Path -Parent $scriptDir } else { $null }
$errorLog = if ($projectDir) { Join-Path $projectDir "logs\run-error.log" } else { Join-Path $env:TEMP "terry-run-error.log" }

function Write-Utf8([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::AppendAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

$lock = $null

try {
  if (-not $projectDir) { throw "Could not determine the project directory" }
  Set-Location $projectDir

  $logDir = Join-Path $projectDir "logs"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

  # A lock file, not process inspection. A task running under S4U lives in
  # session 0, and an ordinary interactive session cannot read its command line
  # at all - Win32_Process returns it empty - so a guard built on matching
  # command lines is blind to exactly the process it needs to see. An
  # exclusively opened file works across sessions, needs no privileges, and is
  # released by the OS if the process dies without cleaning up.
  $lockPath = Join-Path $logDir "terry.lock"
  try {
    $lock = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None)
  }
  catch {
    $msg = "=== refused to start {0} ===`r`nAnother instance holds {1}.`r`nTwo clients on one token fight over presence.`r`n`r`n" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $lockPath
    Write-Utf8 $errorLog $msg
    # Not an error: declining to start a duplicate is the correct outcome.
    exit 0
  }

  $pidBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$PID)
  $lock.SetLength(0)
  $lock.Write($pidBytes, 0, $pidBytes.Length)
  $lock.Flush()

  # Prune before starting, so a long-running process still gets tidied on restart.
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem -Path $logDir -Filter "terry-*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  # A scheduled task does not inherit an interactive PATH, so look in the usual
  # places rather than assuming bun can be found by name.
  $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $bun) {
    $candidate = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $candidate) { $bun = $candidate }
  }
  if (-not $bun) { throw "bun was not found on PATH, or under .bun\bin for user '$env:USERNAME'" }

  if (-not (Test-Path (Join-Path $projectDir ".env"))) {
    throw "No .env in $projectDir; the service cannot start without configuration"
  }

  # The service opens this itself and holds the handle for its own lifetime.
  $env:LOG_FILE = Join-Path $logDir ("terry-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

  & $bun run src\index.ts
  exit $LASTEXITCODE
}
catch {
  $detail = @(
    "=== launch failed {0} ===" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    "user       : $env:USERNAME"
    "projectDir : $projectDir"
    "userProfile: $env:USERPROFILE"
    "error      : $($_.Exception.Message)"
    ""
  ) -join "`r`n"
  Write-Utf8 $errorLog $detail
  exit 1
}
finally {
  if ($lock) { $lock.Close(); $lock.Dispose() }
}
