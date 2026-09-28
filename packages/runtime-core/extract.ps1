param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  [long]$total = 0
  if ($zip.Entries.Count -gt 100000) { throw 'Too many ZIP entries' }
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName))
    if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP entry escapes destination' }
    if ($entry.FullName.Contains(':')) { throw 'ZIP alternate streams are forbidden' }
    $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($kind -eq 0xA000) { throw 'ZIP symlinks are forbidden' }
    $total += $entry.Length
    if ($total -gt 4GB) { throw 'Expanded ZIP exceeds 4 GB' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
