[CmdletBinding()]
param(
  [string]$ConnectionString =
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  [string]$PsqlPath =
    'C:\Users\theo-\scoop\apps\postgresql\current\bin\psql.exe'
)

$ErrorActionPreference = 'Stop'

# This harness is destructive to its deterministic fixture IDs. Refuse every
# target except the disposable Supabase database exposed by this repository.
try {
  $connectionUri = [System.Uri]::new(
    $ConnectionString,
    [System.UriKind]::Absolute
  )
}
catch {
  throw 'connection_string_invalid'
}

$allowedHosts = @('127.0.0.1', 'localhost')
if ($connectionUri.Scheme -ne 'postgresql' -or
    $allowedHosts -notcontains $connectionUri.Host.ToLowerInvariant() -or
    $connectionUri.Port -ne 54322 -or
    $connectionUri.AbsolutePath -ne '/postgres' -or
    -not [string]::IsNullOrEmpty($connectionUri.Query) -or
    -not [string]::IsNullOrEmpty($connectionUri.Fragment)) {
  throw 'connection_target_must_be_local_supabase_postgres_54322'
}

if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) {
  $psqlCommand = Get-Command psql -ErrorAction SilentlyContinue
  if ($null -eq $psqlCommand) {
    throw 'psql_not_found'
  }
  $PsqlPath = $psqlCommand.Source
}

$cabinetId = '97000000-0000-4000-8000-000000000001'
$userAId = '96000000-0000-4000-8000-000000000001'
$userBId = '96000000-0000-4000-8000-000000000002'
$membershipAId = '98000000-0000-4000-8000-000000000001'
$membershipBId = '98000000-0000-4000-8000-000000000002'

function Invoke-PsqlCommand {
  param([Parameter(Mandatory)][string]$Sql)

  $output = & $PsqlPath $ConnectionString -X -v ON_ERROR_STOP=1 -A -t -c $Sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "psql_command_failed exit=$LASTEXITCODE output=$($output -join ' | ')"
  }
  return @($output)
}

function Start-PsqlSession {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $PsqlPath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.Arguments =
    "`"$ConnectionString`" -X -q -A -t -v ON_ERROR_STOP=1"

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw 'psql_session_start_failed'
  }
  $process.StandardInput.AutoFlush = $true
  return $process
}

function Wait-PsqlMarker {
  param(
    [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory)][string]$Prefix,
    [int]$TimeoutMilliseconds = 5000
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $remaining = [Math]::Max(
      1,
      [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
    )
    $readTask = $Process.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait($remaining)) {
      throw "psql_marker_timeout prefix=$Prefix"
    }
    $line = $readTask.Result
    if ($null -eq $line) {
      $stderr = $Process.StandardError.ReadToEnd()
      throw "psql_session_ended_before_marker prefix=$Prefix stderr=$stderr"
    }
    if ($line.StartsWith($Prefix, [StringComparison]::Ordinal)) {
      return $line.Substring($Prefix.Length)
    }
  }
  throw "psql_marker_timeout prefix=$Prefix"
}

function Wait-PsqlExit {
  param(
    [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
    [int]$TimeoutMilliseconds = 5000
  )

  if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
    throw 'psql_session_exit_timeout'
  }
}

$sessionA = $null
$sessionB = $null
$testFailure = $null
$cleanupFailure = $null

try {
  # Remove only the harness' deterministic synthetic identifiers, then create
  # two active admins visible to both database backends.
  [void](Invoke-PsqlCommand -Sql @"
BEGIN;
DELETE FROM public.cabinets WHERE id = '$cabinetId';
DELETE FROM auth.users WHERE id IN ('$userAId', '$userBId');
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin
) VALUES
  ('$userAId', 'concurrent-a@example.invalid', '', NOW(), NOW(), NOW(), '{}', '{}', FALSE),
  ('$userBId', 'concurrent-b@example.invalid', '', NOW(), NOW(), NOW(), '{}', '{}', FALSE);
INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES (
  '$cabinetId', 'Synthetic concurrent portal', 'synthetic-concurrent-portal',
  '+41000000197', 'concurrent@example.invalid', 'actif'
);
INSERT INTO public.cabinet_memberships (
  id, cabinet_id, user_id, role, actif
) VALUES
  ('$membershipAId', '$cabinetId', '$userAId', 'admin', TRUE),
  ('$membershipBId', '$cabinetId', '$userBId', 'admin', TRUE);
COMMIT;
"@)

  $sessionA = Start-PsqlSession
  $sessionA.StandardInput.WriteLine('\set VERBOSITY verbose')
  $sessionA.StandardInput.WriteLine('BEGIN;')
  $sessionA.StandardInput.WriteLine(
    "UPDATE public.cabinet_memberships SET actif = FALSE WHERE id = '$membershipAId';"
  )
  $sessionA.StandardInput.WriteLine(
    "SELECT 'PORTAL_CONCURRENCY_A_READY:' || pg_backend_pid();"
  )
  $backendA = Wait-PsqlMarker -Process $sessionA -Prefix 'PORTAL_CONCURRENCY_A_READY:'

  $sessionB = Start-PsqlSession
  $sessionB.StandardInput.WriteLine('\set VERBOSITY verbose')
  $sessionB.StandardInput.WriteLine(
    "SELECT 'PORTAL_CONCURRENCY_B_READY:' || pg_backend_pid();"
  )
  $sessionB.StandardInput.WriteLine(
    "DELETE FROM public.cabinet_memberships WHERE id = '$membershipBId';"
  )
  $sessionB.StandardInput.WriteLine('\q')
  $backendB = Wait-PsqlMarker -Process $sessionB -Prefix 'PORTAL_CONCURRENCY_B_READY:'

  if ($backendA -eq $backendB) {
    throw "concurrency_sessions_share_backend pid=$backendA"
  }
  if ($backendA -notmatch '^\d+$' -or $backendB -notmatch '^\d+$') {
    throw "invalid_backend_pid backend_a=$backendA backend_b=$backendB"
  }

  $waitDeadline = [DateTime]::UtcNow.AddSeconds(5)
  $waitEvent = $null
  while ([DateTime]::UtcNow -lt $waitDeadline -and $waitEvent -ne 'Lock:advisory') {
    if ($sessionB.HasExited) {
      $prematureStderr = $sessionB.StandardError.ReadToEnd()
      throw "concurrent_delete_did_not_block exit=$($sessionB.ExitCode) stderr=$prematureStderr"
    }
    $waitOutput = Invoke-PsqlCommand -Sql @"
SELECT COALESCE(wait_event_type || ':' || wait_event, 'not_waiting')
FROM pg_catalog.pg_stat_activity
WHERE pid = $backendB;
"@
    $waitEvent = ($waitOutput | Where-Object { $_ -ne '' } | Select-Object -Last 1)
    if ($waitEvent -ne 'Lock:advisory') {
      Start-Sleep -Milliseconds 50
    }
  }
  if ($waitEvent -ne 'Lock:advisory') {
    throw "concurrent_delete_wait_event_wrong event=$waitEvent"
  }

  $sessionA.StandardInput.WriteLine('COMMIT;')
  $sessionA.StandardInput.WriteLine('\q')
  Wait-PsqlExit -Process $sessionA
  Wait-PsqlExit -Process $sessionB

  $stderrA = $sessionA.StandardError.ReadToEnd()
  $stderrB = $sessionB.StandardError.ReadToEnd()
  if ($sessionA.ExitCode -ne 0) {
    throw "first_admin_transition_failed exit=$($sessionA.ExitCode) stderr=$stderrA"
  }
  if ($sessionB.ExitCode -eq 0) {
    throw 'concurrent_last_admin_delete_succeeded'
  }
  if (-not $stderrB.Contains('23514') -or
      -not $stderrB.Contains('cabinet_requires_active_admin')) {
    throw "concurrent_delete_failed_for_wrong_reason exit=$($sessionB.ExitCode) stderr=$stderrB"
  }

  $state = Invoke-PsqlCommand -Sql @"
SELECT
  COUNT(*) FILTER (WHERE role = 'admin' AND actif)::TEXT
  || ':' || COUNT(*)::TEXT
FROM public.cabinet_memberships
WHERE cabinet_id = '$cabinetId';
"@
  $stateValue = ($state | Where-Object { $_ -match '^\d+:\d+$' } | Select-Object -Last 1)
  if ($stateValue -ne '1:2') {
    throw "concurrent_guard_final_state_invalid state=$stateValue"
  }

  Write-Output (
    "PORTAL_TENANT_RLS_CONCURRENCY_PASS " +
    "backend_a=$backendA backend_b=$backendB " +
    'observed_wait=Lock:advisory rejected_sqlstate=23514 active_admins=1 total_memberships=2'
  )
}
catch {
  $testFailure = $_
}
finally {
  foreach ($session in @($sessionB, $sessionA)) {
    if ($null -ne $session) {
      if (-not $session.HasExited) {
        $session.Kill($true)
        [void]$session.WaitForExit(5000)
      }
      $session.Dispose()
    }
  }

  try {
    [void](Invoke-PsqlCommand -Sql @"
BEGIN;
DELETE FROM public.cabinets WHERE id = '$cabinetId';
DELETE FROM auth.users WHERE id IN ('$userAId', '$userBId');
COMMIT;
"@)

    $remaining = Invoke-PsqlCommand -Sql @"
SELECT
  (SELECT COUNT(*) FROM public.cabinets WHERE id = '$cabinetId')
  + (SELECT COUNT(*) FROM public.cabinet_memberships WHERE cabinet_id = '$cabinetId')
  + (SELECT COUNT(*) FROM auth.users WHERE id IN ('$userAId', '$userBId'));
"@
    $remainingCount = ($remaining | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
    if ($remainingCount -ne '0') {
      throw "concurrency_cleanup_left_residues count=$remainingCount"
    }
  }
  catch {
    $cleanupFailure = $_
  }
}

if ($null -ne $testFailure) {
  if ($null -ne $cleanupFailure) {
    throw "$($testFailure.Exception.Message); cleanup=$($cleanupFailure.Exception.Message)"
  }
  throw $testFailure
}
if ($null -ne $cleanupFailure) {
  throw $cleanupFailure
}

Write-Output 'PORTAL_TENANT_RLS_CONCURRENCY_CLEANUP_PASS residues=0'
