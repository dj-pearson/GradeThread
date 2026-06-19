<#
.SYNOPSIS
  Schema catch-up 00254 -> 00256. Fixes the edge restart loop:
    [schema-version] DB is STALE: applied=00254, this build expects 00256.
    Refusing to start.

.DESCRIPTION
  The edge boot guard (services/edge-functions/src/lib/schema-version.ts,
  EXPECTED_SCHEMA_VERSION="00256") refuses to start until prod's recorded schema
  version reaches 00256. Prod is at 00254, so two migrations are pending:
    00255_drip_campaign_definitions.sql   (US-945)
    00256_garment_passport_core.sql       (US-1089)
  Both are idempotent and self-record their version (US-1108 footer), so this is
  safe to re-run and the boot guard advances no matter the apply path.

  PowerShell-native (calls psql directly) so it works from your default shell
  without bash/WSL. Requires psql on PATH.

.EXAMPLE
  # back up prod first (BACKUPS.md), then:
  $env:SUPABASE_DB_URL = "postgres://...@db-host:5432/postgres"
  ./scripts/catchup-00256.ps1
#>
[CmdletBinding()]
param(
  [string]$DbUrl = $env:SUPABASE_DB_URL
)
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DbUrl)) {
  throw "Set `$env:SUPABASE_DB_URL (or pass -DbUrl) to the prod Postgres connection string."
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
  throw "psql not found on PATH."
}

$migrations = Join-Path $PSScriptRoot '..\supabase\migrations' | Resolve-Path

function Get-SchemaVersion {
  $v = & psql $DbUrl -tAX -c "SELECT coalesce(public.latest_schema_migration(), '00000');"
  if ($LASTEXITCODE -ne 0) { throw "psql failed reading current schema version (check SUPABASE_DB_URL / connectivity)." }
  return ($v | Out-String).Trim()
}

$before = Get-SchemaVersion
Write-Host "[catchup] recorded schema version before: $before"

foreach ($prefix in '00255', '00256') {
  $file = Get-ChildItem -Path $migrations -Filter "$prefix`_*.sql" | Select-Object -First 1
  if (-not $file) { throw "Migration file for $prefix not found in $migrations" }
  Write-Host "[catchup] applying $($file.Name)"
  & psql $DbUrl -v ON_ERROR_STOP=1 -f $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "psql failed applying $($file.Name) — aborting." }
}

$after = Get-SchemaVersion
Write-Host "[catchup] recorded schema version after: $after"

if ($after -eq '00256') {
  Write-Host "[catchup] OK - DB now at 00256. Restart/redeploy the edge service; the boot guard will pass." -ForegroundColor Green
} else {
  throw "[catchup] expected 00256 but DB reports '$after' - do NOT restart the edge yet; investigate."
}
