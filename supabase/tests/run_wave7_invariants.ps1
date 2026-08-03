[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$containerName = 'supabase_db_corya'
$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$cleanupPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'wave7_cleanup.sql')).Path
$testPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'wave7_invariants.sql')).Path

if (-not (Test-Path -LiteralPath $dockerExe -PathType Leaf)) {
  throw 'Docker CLI not found at the expected local Docker Desktop path.'
}

$contextName = (& $dockerExe context show).Trim()
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to inspect the Docker context.'
}
$contextJson = & $dockerExe context inspect $contextName
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to inspect the Docker context.'
}
$contextInfo = @($contextJson | ConvertFrom-Json)[0]
if ([string]$contextInfo.Endpoints.docker.Host -notlike 'npipe://*') {
  throw 'Refusing a Docker context that is not a local Windows named pipe.'
}

$inspectJson = & $dockerExe inspect $containerName
if ($LASTEXITCODE -ne 0) {
  throw 'Local Supabase DB container not found.'
}
$containerInfo = @($inspectJson | ConvertFrom-Json)[0]
$projectLabel = [string]$containerInfo.Config.Labels.'com.supabase.cli.project'
$portBindings = @($containerInfo.HostConfig.PortBindings.'5432/tcp')
$matchingPorts = @($portBindings | Where-Object { $_.HostPort -eq '54322' })
if ([string]$containerInfo.Name -ne ('/' + $containerName) -or
    [string]$containerInfo.Config.Image -notlike 'public.ecr.aws/supabase/postgres:*' -or
    -not [bool]$containerInfo.State.Running -or
    [string]$containerInfo.State.Health.Status -ne 'healthy' -or
    $projectLabel -ne 'corya' -or
    $matchingPorts.Count -ne 1) {
  throw 'Local Supabase DB identity, health, project, or port validation failed.'
}

$probeSql = 'SELECT current_database(), inet_server_port(), public.get_wave7_contract_version();'
$probe = (& $dockerExe exec $containerName psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -At -F ',' -c $probeSql).Trim()
if ($LASTEXITCODE -ne 0) {
  throw 'Local database contract probe failed.'
}
if ($probe -ne 'postgres,5432,7') {
  throw 'Unexpected local database contract probe.'
}

Write-Host 'Validated local Wave 7 database target.'

$cleanupContainerPath = $containerName + ':/tmp/wave7_cleanup.sql'
$testContainerPath = $containerName + ':/tmp/wave7_invariants.sql'
& $dockerExe cp $cleanupPath $cleanupContainerPath
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to copy cleanup SQL into the local DB container.'
}
& $dockerExe cp $testPath $testContainerPath
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to copy invariant SQL into the local DB container.'
}

$testFailure = $null
$cleanupExitCode = 0

try {
  & $dockerExe exec $containerName psql -U postgres -d postgres -v ON_ERROR_STOP=1 -P pager=off -f /tmp/wave7_cleanup.sql
  if ($LASTEXITCODE -ne 0) {
    throw 'Wave 7 pre-cleanup failed.'
  }

  & $dockerExe exec $containerName psql -U postgres -d postgres -v ON_ERROR_STOP=1 -P pager=off -f /tmp/wave7_invariants.sql
  if ($LASTEXITCODE -ne 0) {
    throw 'Wave 7 invariants failed.'
  }
} catch {
  $testFailure = $_
} finally {
  & $dockerExe exec $containerName psql -U postgres -d postgres -v ON_ERROR_STOP=1 -P pager=off -f /tmp/wave7_cleanup.sql
  $cleanupExitCode = $LASTEXITCODE
}

if ($cleanupExitCode -ne 0) {
  throw 'Wave 7 final cleanup failed.'
}
if ($null -ne $testFailure) {
  throw $testFailure
}

Write-Host 'WAVE7_INVARIANTS_PASS fixtures=0 target=local'
