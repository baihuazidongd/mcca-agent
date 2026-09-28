param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$source = Join-Path $repo 'config'
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Destination must be a new directory. No existing user data is overwritten.' }
if ($target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $target -eq $source) { throw 'Destination must be outside the existing config directory.' }
New-Item -ItemType Directory -Path $target -Force | Out-Null
# Copy a snapshot, do not delete or rewrite the working installation. Stop
# writers before using the copy as the active data directory.
& robocopy $source $target /E /XJ /XD .git node_modules /XF *.tmp /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'Data snapshot failed; source data is intact.' }
$manifest = @{ schemaVersion=1; source=$source; destination=$target; createdAt=(Get-Date).ToString('o'); mode='copy'; sourceRemoved=$false }
[IO.File]::WriteAllText((Join-Path $target 'migration.json'), ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Snapshot saved to $target. To use it, set MCCA_DATA_DIR when launching. Source data is unchanged."
