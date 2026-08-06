[CmdletBinding()]
param(
  [string]$ConnectionString =
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  [string]$PsqlPath =
    'C:\Users\theo-\scoop\apps\postgresql\current\bin\psql.exe'
)

$ErrorActionPreference = 'Stop'

# The harness bulk-creates and deletes synthetic calls. Refuse every target
# except this repository's disposable local Supabase PostgreSQL endpoint.
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

$cabinetId = 'b7000000-0000-4000-8000-000000000001'
$baselineCallCount = 250000
$sentinelCallId = 'b8000000-0000-4000-8000-000000000001'

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
    [int]$TimeoutMilliseconds = 15000
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

$reader = $null
$testFailure = $null
$cleanupFailure = $null

try {
  [void](Invoke-PsqlCommand -Sql @"
BEGIN;
DELETE FROM public.cabinets WHERE id = '$cabinetId';
INSERT INTO public.cabinets (
  id, nom, slug, numero_corya, email_notification, statut
) VALUES (
  '$cabinetId', 'Synthetic dashboard concurrency',
  'synthetic-dashboard-concurrency', '+41000000307',
  'dashboard-concurrency@example.invalid', 'actif'
);
INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes,
  resultat, motif_appel, email_status
)
SELECT
  pg_catalog.gen_random_uuid(),
  '$cabinetId'::UUID,
  'dashboard-snapshot-concurrency-' || generated.n::TEXT,
  NOW() - INTERVAL '1 day',
  30,
  CASE generated.n % 6
    WHEN 0 THEN 'rdv_pris'
    WHEN 1 THEN 'message'
    WHEN 2 THEN 'transfere'
    WHEN 3 THEN 'urgence'
    WHEN 4 THEN 'refus'
    ELSE 'echec'
  END,
  'motif synthetique',
  'sent'
FROM pg_catalog.generate_series(1, $baselineCallCount) AS generated(n);
COMMIT;
"@)

  $reader = Start-PsqlSession
  $reader.StandardInput.WriteLine("SELECT 'PORTAL_DASHBOARD_READER_READY:' || pg_backend_pid();")
  $reader.StandardInput.WriteLine(@"
SELECT 'PORTAL_DASHBOARD_READER_RESULT:' || snapshot.total_calls::TEXT
FROM public.get_portal_dashboard_snapshot('$cabinetId', '7d') AS snapshot;
"@)
  $reader.StandardInput.WriteLine('\q')
  $readerPid = Wait-PsqlMarker -Process $reader -Prefix 'PORTAL_DASHBOARD_READER_READY:'
  if ($readerPid -notmatch '^\d+$') {
    throw "invalid_reader_backend_pid pid=$readerPid"
  }

  # backend_xmin proves that the function statement has acquired its MVCC
  # snapshot before the sentinel INSERT commits.
  $snapshotDeadline = [DateTime]::UtcNow.AddSeconds(10)
  $readerState = $null
  while ([DateTime]::UtcNow -lt $snapshotDeadline -and
         $readerState -notmatch '^active:\d+$') {
    if ($reader.HasExited) {
      throw 'dashboard_reader_finished_before_snapshot_was_observed'
    }
    $stateOutput = Invoke-PsqlCommand -Sql @"
SELECT state || ':' || COALESCE(backend_xmin::TEXT, '')
FROM pg_catalog.pg_stat_activity
WHERE pid = $readerPid
  AND query LIKE '%get_portal_dashboard_snapshot%';
"@
    $readerState = ($stateOutput | Where-Object { $_ -ne '' } | Select-Object -Last 1)
    if ($readerState -notmatch '^active:\d+$') {
      Start-Sleep -Milliseconds 20
    }
  }
  if ($readerState -notmatch '^active:\d+$') {
    throw "dashboard_reader_snapshot_not_observed state=$readerState"
  }

  [void](Invoke-PsqlCommand -Sql @"
INSERT INTO public.appels (
  id, cabinet_id, retell_call_id, date_appel, duree_secondes,
  resultat, motif_appel, email_status
) VALUES (
  '$sentinelCallId', '$cabinetId', 'dashboard-snapshot-concurrency-sentinel',
  NOW() - INTERVAL '1 day', 30, 'rdv_pris', 'sentinelle synthetique', 'sent'
);
"@)

  $postCommitState = Invoke-PsqlCommand -Sql @"
SELECT state
FROM pg_catalog.pg_stat_activity
WHERE pid = $readerPid
  AND query LIKE '%get_portal_dashboard_snapshot%';
"@
  if (($postCommitState | Where-Object { $_ -eq 'active' }).Count -ne 1) {
    throw 'dashboard_reader_finished_before_concurrent_commit_was_observed'
  }

  $snapshotCount = Wait-PsqlMarker `
    -Process $reader `
    -Prefix 'PORTAL_DASHBOARD_READER_RESULT:'
  if (-not $reader.WaitForExit(15000)) {
    throw 'dashboard_reader_exit_timeout'
  }
  $readerStderr = $reader.StandardError.ReadToEnd()
  if ($reader.ExitCode -ne 0) {
    throw "dashboard_reader_failed exit=$($reader.ExitCode) stderr=$readerStderr"
  }
  if ($snapshotCount -ne $baselineCallCount.ToString()) {
    throw "dashboard_snapshot_mixed_concurrent_insert count=$snapshotCount"
  }

  $freshOutput = Invoke-PsqlCommand -Sql @"
SELECT total_calls::TEXT
FROM public.get_portal_dashboard_snapshot('$cabinetId', '7d');
"@
  $freshCount = ($freshOutput | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
  $expectedFreshCount = ($baselineCallCount + 1).ToString()
  if ($freshCount -ne $expectedFreshCount) {
    throw "dashboard_fresh_snapshot_missing_committed_insert count=$freshCount"
  }

  Write-Output (
    "PORTAL_DASHBOARD_SNAPSHOT_CONCURRENCY_PASS reader_pid=$readerPid " +
    "snapshot_count=$snapshotCount fresh_count=$freshCount"
  )
}
catch {
  $testFailure = $_
}
finally {
  if ($null -ne $reader) {
    if (-not $reader.HasExited) {
      $reader.Kill($true)
      [void]$reader.WaitForExit(5000)
    }
    $reader.Dispose()
  }

  try {
    [void](Invoke-PsqlCommand -Sql "DELETE FROM public.cabinets WHERE id = '$cabinetId';")
    $remainingOutput = Invoke-PsqlCommand -Sql @"
SELECT
  (SELECT COUNT(*) FROM public.cabinets WHERE id = '$cabinetId')
  + (SELECT COUNT(*) FROM public.appels WHERE cabinet_id = '$cabinetId');
"@
    $remaining = ($remainingOutput | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
    if ($remaining -ne '0') {
      throw "dashboard_concurrency_cleanup_left_residues count=$remaining"
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

Write-Output 'PORTAL_DASHBOARD_SNAPSHOT_CONCURRENCY_CLEANUP_PASS residues=0'
