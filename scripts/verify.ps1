#requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$reproRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dllPath = Join-Path $reproRoot 'bin/Debug/net10.0/DebugMcpRepro.dll'
$pdbPath = [System.IO.Path]::ChangeExtension($dllPath, '.pdb')
if (-not (Test-Path -LiteralPath $dllPath) -or -not (Test-Path -LiteralPath $pdbPath)) {
    throw 'Run dotnet build --configuration Debug first.'
}

$expectedAll = @('A result=48', 'B result=49', 'C result=50', 'D result=37',
    'D_FALSE result=51', 'E result=52', 'F result=53') -join "`n"
$cases = @(
    @{ Args = @('sync'); Expected = 'A result=48'; Exit = 0 },
    @{ Args = @('completed-await'); Expected = 'B result=49'; Exit = 0 },
    @{ Args = @('suspended-await'); Expected = 'C result=50'; Exit = 0 },
    @{ Args = @('assigned-after-await'); Expected = 'D result=37'; Exit = 0 },
    @{ Args = @('assigned-after-await-success'); Expected = 'D_FALSE result=51'; Exit = 0 },
    @{ Args = @('projection'); Expected = 'E result=52'; Exit = 0 },
    @{ Args = @('out-of-scope'); Expected = 'F result=53'; Exit = 0 },
    @{ Args = @('all'); Expected = $expectedAll; Exit = 0 },
    @{ Args = @(); Expected = $expectedAll; Exit = 0 },
    @{ Args = @('unknown'); Expected = 'INPUT result=unknown-scenario'; Exit = 2 },
    @{ Args = @('sync', 'extra'); Expected = 'INPUT result=invalid'; Exit = 2 }
)

foreach ($case in $cases) {
    $start = [System.Diagnostics.ProcessStartInfo]::new('dotnet')
    $start.WorkingDirectory = $reproRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add($dllPath)
    foreach ($argument in $case.Args) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    $label = if ($case.Args.Count) { $case.Args -join ' ' } else { '(default)' }
    try {
        if (-not $process.Start()) { throw "Cannot start $label" }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            # This handle belongs only to the process launched above.
            $process.Kill($true)
            $process.WaitForExit()
            throw "Timeout after 10 seconds: $label"
        }
        $output = $outputTask.GetAwaiter().GetResult().Replace("`r`n", "`n").TrimEnd()
        $errorOutput = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne $case.Exit -or $output -cne $case.Expected -or $errorOutput.Length) {
            throw "Unexpected result for ${label}: exit=$($process.ExitCode); stdout=$output; stderr=$errorOutput"
        }
        Write-Output "PASS $label"
    }
    finally { $process.Dispose() }
}

# Verify the actual portable PDB, its DLL association, and source checksums.
# This checks files on disk, not which module a live debug adapter has loaded.
$pdbStream = [System.IO.File]::OpenRead($pdbPath)
$provider = [System.Reflection.Metadata.MetadataReaderProvider]::FromPortablePdbStream($pdbStream)
try {
    $reader = $provider.GetMetadataReader()
    $documentsChecked = 0
    foreach ($handle in $reader.Documents) {
        $document = $reader.GetDocument($handle)
        $documentPath = $reader.GetString($document.Name)
        if ($reader.GetGuid($document.HashAlgorithm).ToString() -ne '8829d00f-11b8-4213-878b-770e8597ac16') {
            throw "Unexpected source hash algorithm: $documentPath"
        }
        $expectedHash = [Convert]::ToHexString($reader.GetBlobBytes($document.Hash))
        if ((Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash -ne $expectedHash) {
            throw "PDB source checksum mismatch: $documentPath"
        }
        $documentsChecked++
    }
    if ($documentsChecked -lt 3) { throw 'Source documents missing from PDB.' }

    $dllStream = [System.IO.File]::OpenRead($dllPath)
    $pe = [System.Reflection.PortableExecutable.PEReader]::new($dllStream)
    try {
        $matched = $false
        foreach ($entry in $pe.ReadDebugDirectory()) {
            if ($entry.Type -eq [System.Reflection.PortableExecutable.DebugDirectoryEntryType]::CodeView) {
                $codeView = $pe.ReadCodeViewDebugDirectoryData($entry)
                $idBytes = [byte[]]$reader.DebugMetadataHeader.Id
                $pdbGuid = [Guid]::new([byte[]]$idBytes[0..15])
                $pdbStamp = [BitConverter]::ToUInt32($idBytes, 16)
                $matched = $codeView.Guid -eq $pdbGuid -and $entry.Stamp -eq $pdbStamp -and $codeView.Age -eq 1
                if (-not $matched) { throw 'DLL/PDB debug identifiers differ.' }
            }
        }
        if (-not $matched) { throw 'DLL has no matching CodeView entry.' }
    }
    finally { $pe.Dispose(); $dllStream.Dispose() }
    Write-Output "PASS portable PDB: DLL identity and $documentsChecked source checksums"
}
finally { $provider.Dispose(); $pdbStream.Dispose() }

Write-Output 'PASS normal execution and build artifacts; debugger evaluation NOT tested'
