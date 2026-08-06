[CmdletBinding()]
param(
  [string]$ConnectionString =
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  [string]$PsqlPath =
    'C:\Users\theo-\scoop\apps\postgresql\current\bin\psql.exe'
)

$ErrorActionPreference = 'Stop'

# This harness deletes deterministic fixtures. It must never target a remote DB.
try {
  $connectionUri = [System.Uri]::new($ConnectionString, [System.UriKind]::Absolute)
}
catch {
  throw 'connection_string_invalid'
}

if ($connectionUri.Scheme -ne 'postgresql' -or
    @('127.0.0.1', 'localhost') -notcontains $connectionUri.Host.ToLowerInvariant() -or
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

$cabinetId = 'a7000000-0000-4000-8000-000000000001'
$userId = 'a6000000-0000-4000-8000-000000000001'
$membershipId = 'a8000000-0000-4000-8000-000000000001'

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
  $startInfo.Arguments = "`"$ConnectionString`" -X -q -A -t -v ON_ERROR_STOP=1"

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
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
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
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)

  if (-not $Process.WaitForExit(5000)) {
    throw 'psql_session_exit_timeout'
  }
}

$sessionA = $null
$sessionB = $null
$testFailure = $null
$cleanupFailure = $null

try {
  [void](Invoke-PsqlCommand -Sql @"
BEGIN;
DELETE FROM public.cabinets WHERE id = '$cabinetId';
DELETE FROM auth.users WHERE id = '$userId';
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin
) VALUES (
  '$userId', 'portal-atomic-concurrency@example.invalid', '', NOW(),
  NOW(), NOW(), '{}', '{}', FALSE
);
INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, ville, statut, config_agent
) VALUES (
  '$cabinetId', 'Initial name', 'portal-atomic-concurrency', '+41000000207',
  'portal-atomic-concurrency@example.invalid', 'Initial city', 'actif',
  pg_catalog.jsonb_build_object(
    'legacy', pg_catalog.jsonb_build_object('keep', TRUE)
  )
);
INSERT INTO public.cabinet_memberships (id, cabinet_id, user_id, role, actif)
VALUES ('$membershipId', '$cabinetId', '$userId', 'admin', TRUE);
COMMIT;
"@)

  $expectedOutput = Invoke-PsqlCommand -Sql @"
SELECT updated_at::TEXT FROM public.cabinets WHERE id = '$cabinetId';
"@
  $expectedUpdatedAt = ($expectedOutput | Where-Object { $_ -ne '' } | Select-Object -Last 1)
  if ([string]::IsNullOrWhiteSpace($expectedUpdatedAt)) {
    throw 'expected_updated_at_missing'
  }

  $sessionA = Start-PsqlSession
  $sessionA.StandardInput.WriteLine('\set VERBOSITY verbose')
  $sessionA.StandardInput.WriteLine('BEGIN;')
  $sessionA.StandardInput.WriteLine(@"
SELECT * FROM public.apply_portal_cabinet_patch_with_audit(
  '$cabinetId', '$userId', 'settings_updated', '$expectedUpdatedAt'::TIMESTAMPTZ,
  pg_catalog.jsonb_build_object('nom', 'Winner A'), ARRAY['practiceName']
);
"@)
  $sessionA.StandardInput.WriteLine("SELECT 'PORTAL_ATOMIC_A_READY:' || pg_backend_pid();")
  $backendA = Wait-PsqlMarker -Process $sessionA -Prefix 'PORTAL_ATOMIC_A_READY:'

  $sessionB = Start-PsqlSession
  $sessionB.StandardInput.WriteLine('\set VERBOSITY verbose')
  $sessionB.StandardInput.WriteLine("SELECT 'PORTAL_ATOMIC_B_READY:' || pg_backend_pid();")
  $sessionB.StandardInput.WriteLine(@"
SELECT * FROM public.apply_portal_cabinet_patch_with_audit(
  '$cabinetId', '$userId', 'settings_updated', '$expectedUpdatedAt'::TIMESTAMPTZ,
  pg_catalog.jsonb_build_object('ville', 'Loser B'), ARRAY['city']
);
"@)
  $sessionB.StandardInput.WriteLine('\q')
  $backendB = Wait-PsqlMarker -Process $sessionB -Prefix 'PORTAL_ATOMIC_B_READY:'

  if ($backendA -eq $backendB -or $backendA -notmatch '^\d+$' -or $backendB -notmatch '^\d+$') {
    throw "invalid_concurrency_backends backend_a=$backendA backend_b=$backendB"
  }

  $waitDeadline = [DateTime]::UtcNow.AddSeconds(5)
  $waitEvent = $null
  while ([DateTime]::UtcNow -lt $waitDeadline -and
         ([string]::IsNullOrEmpty($waitEvent) -or -not $waitEvent.StartsWith('Lock:'))) {
    if ($sessionB.HasExited) {
      $prematureStderr = $sessionB.StandardError.ReadToEnd()
      throw "second_writer_did_not_block exit=$($sessionB.ExitCode) stderr=$prematureStderr"
    }
    $waitOutput = Invoke-PsqlCommand -Sql @"
SELECT COALESCE(wait_event_type || ':' || wait_event, 'not_waiting')
FROM pg_catalog.pg_stat_activity WHERE pid = $backendB;
"@
    $waitEvent = ($waitOutput | Where-Object { $_ -ne '' } | Select-Object -Last 1)
    if ([string]::IsNullOrEmpty($waitEvent) -or -not $waitEvent.StartsWith('Lock:')) {
      Start-Sleep -Milliseconds 50
    }
  }
  if ([string]::IsNullOrEmpty($waitEvent) -or -not $waitEvent.StartsWith('Lock:')) {
    throw "second_writer_wait_event_wrong event=$waitEvent"
  }

  $sessionA.StandardInput.WriteLine('COMMIT;')
  $sessionA.StandardInput.WriteLine('\q')
  Wait-PsqlExit -Process $sessionA
  Wait-PsqlExit -Process $sessionB

  $stderrA = $sessionA.StandardError.ReadToEnd()
  $stderrB = $sessionB.StandardError.ReadToEnd()
  if ($sessionA.ExitCode -ne 0) {
    throw "first_writer_failed exit=$($sessionA.ExitCode) stderr=$stderrA"
  }
  if ($sessionB.ExitCode -eq 0 -or
      -not $stderrB.Contains('40001') -or
      -not $stderrB.Contains('portal_cabinet_concurrent_update')) {
    throw "second_writer_not_rejected_as_stale exit=$($sessionB.ExitCode) stderr=$stderrB"
  }

  $stateOutput = Invoke-PsqlCommand -Sql @"
SELECT c.nom || ':' || c.ville || ':'
  || COUNT(e.id) FILTER (WHERE e.changed_fields = ARRAY['practiceName'])::TEXT || ':'
  || COUNT(e.id) FILTER (WHERE e.changed_fields = ARRAY['city'])::TEXT || ':'
  || (c.updated_at > '$expectedUpdatedAt'::TIMESTAMPTZ)::TEXT
FROM public.cabinets AS c
LEFT JOIN public.portal_audit_events AS e ON e.cabinet_id = c.id
WHERE c.id = '$cabinetId'
GROUP BY c.id
"@
  $state = ($stateOutput | Where-Object { $_ -ne '' } | Select-Object -Last 1)
  if ($state -ne 'Winner A:Initial city:1:0:true') {
    throw "atomic_concurrency_final_state_wrong state=$state"
  }

  Write-Output (
    "PORTAL_AUDIT_ATOMIC_CONCURRENCY_PASS backend_a=$backendA backend_b=$backendB " +
    "observed_wait=$waitEvent rejected_sqlstate=40001 audits=1"
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
DELETE FROM auth.users WHERE id = '$userId';
COMMIT;
"@)
    $remainingOutput = Invoke-PsqlCommand -Sql @"
SELECT (SELECT COUNT(*) FROM public.cabinets WHERE id = '$cabinetId')
     + (SELECT COUNT(*) FROM public.cabinet_memberships WHERE cabinet_id = '$cabinetId')
     + (SELECT COUNT(*) FROM public.portal_audit_events WHERE cabinet_id = '$cabinetId')
     + (SELECT COUNT(*) FROM auth.users WHERE id = '$userId');
"@
    $remaining = ($remainingOutput | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
    if ($remaining -ne '0') {
      throw "atomic_concurrency_cleanup_left_residues count=$remaining"
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

Write-Output 'PORTAL_AUDIT_ATOMIC_CONCURRENCY_CLEANUP_PASS residues=0'
