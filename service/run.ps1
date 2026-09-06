<#
.SYNOPSIS
  Launches Terry with its output captured to a dated log file.

.DESCRIPTION
  Task Scheduler does not capture a process's stdout or stderr, so running bun
  directly would leave the service with nowhere to report. This wrapper sets the
  working directory (which is how bun finds .env) and appends everything to
  logs\terry-<date>.log.

  Old logs are pruned so an unattended service cannot slowly fill the disk.
#>
[CmdletBinding()]
param(
  [int]$KeepDays = 14
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is not reliably populated in every invocation form, so the
# script's own location is resolved defensively.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { throw "Could not determine this script's directory" }
$projectDir = Split-Path -Parent $scriptDir
Set-Location $projectDir

$logDir = Join-Path $projectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Prune before starting, so a long-running process still gets tidied on restart.
$cutoff = (Get-Date).AddDays(-$KeepDays)
Get-ChildItem -Path $logDir -Filter "terry-*.log" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  Remove-Item -Force -ErrorAction SilentlyContinue

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe" }
if (-not (Test-Path $bun)) { throw "bun was not found on PATH or at $bun" }

$logFile = Join-Path $logDir ("terry-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

# Written as UTF-8 without a BOM. PowerShell's own redirection operators emit
# UTF-16 in Windows PowerShell, which turns a log full of JSON into something
# grep, tail and Select-String cannot read.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$banner = "=== started {0} ===`r`n" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
[System.IO.File]::AppendAllText($logFile, $banner, $utf8)

# Redirected through cmd rather than PowerShell. cmd passes the child's bytes
# straight through, so the JSON stays exactly as the service wrote it. PowerShell
# would re-encode it, and would also wrap every stderr line in an ErrorRecord.
# The service logs structured JSON to stdout and warnings to stderr, and both
# belong in one file, in order.
$quote = [char]34
$command = "{0}{1}{0} run src\index.ts >> {0}{2}{0} 2>&1" -f $quote, $bun, $logFile
& cmd /c $command
