# Issue #1376: disposable GitHub-hosted VM only; never execute either sample.
# This is a diagnostic comparison, not release qualification or a clean verdict.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Run only in a disposable GitHub-hosted Windows runner.'
}
$evidence = New-Item -ItemType Directory -Path 'defender-evidence'
$started = Get-Date
$unqualified = $false
function Save-State($name) {
    Get-MpComputerStatus | ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-status.json"
    Get-MpPreference | ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-preferences.json"
    ConvertTo-Json -InputObject @(Get-MpThreatDetection | Select-Object * -ExcludeProperty CimClass, CimInstanceProperties, CimSystemProperties) -Depth 8 | Set-Content "$evidence/$name-detections.json"
    ConvertTo-Json -InputObject @(Get-MpThreat | Select-Object * -ExcludeProperty CimClass, CimInstanceProperties, CimSystemProperties) -Depth 8 | Set-Content "$evidence/$name-threats.json"
}
function Assert-NotExcluded($file, $log) {
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        $output = @(& $scanner -CheckExclusion -Path $file 2>&1)
        $code = $LASTEXITCODE
        if ($code -eq 1 -and ($output -join "`n") -match 'is not excluded') { break }
        Start-Sleep -Seconds 5
    }
    $output | Set-Content $log
    if ($code -ne 1 -or ($output -join "`n") -notmatch 'is not excluded') { throw "File exclusion state is unqualified: $file" }
}
Save-State 'initial'
Get-ComputerInfo -Property WindowsProductName, WindowsVersion, OsBuildNumber |
    ConvertTo-Json | Set-Content "$evidence/windows.json"
try {
    # Hosted images exclude both drives and disable scanning. Strengthen only this
    # disposable VM. Leave cloud participation/sample-submission settings alone.
    $preferences = Get-MpPreference
    foreach ($kind in @('ExclusionPath', 'ExclusionExtension', 'ExclusionProcess')) {
        $values = @($preferences.$kind | Where-Object { $_ })
        if ($values.Count -gt 0) {
            $arguments = @{ $kind = $values }
            Remove-MpPreference @arguments
        }
    }
    Set-MpPreference -DisableRealtimeMonitoring $false -DisableArchiveScanning $false -DisableIOAVProtection $false -DisableBehaviorMonitoring $false -DisableScriptScanning $false
    Update-MpSignature
    # Defender applies preference changes asynchronously. Wait for the service's
    # observed state rather than accepting only the requested preference value.
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { break }
        Start-Sleep -Seconds 5
    }
    Save-State 'ready'
    $status = Get-MpComputerStatus
    $preferences = Get-MpPreference
    if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled -or $preferences.DisableArchiveScanning) {
        throw 'Defender antivirus, real-time protection, and archive scanning must be active.'
    }
    if (@($preferences.ExclusionPath + $preferences.ExclusionExtension + $preferences.ExclusionProcess | Where-Object { $_ }).Count -gt 0) {
        throw 'Runner exclusions remain; this comparison is unqualified.'
    }
    $platform = Get-ChildItem "$env:ProgramData/Microsoft/Windows Defender/Platform" -Directory |
        Sort-Object Name -Descending | Select-Object -First 1
    $scanner = if ($platform) { Join-Path $platform.FullName 'MpCmdRun.exe' } else { "$env:ProgramFiles/Windows Defender/MpCmdRun.exe" }
    $definition = (Get-MpComputerStatus).AntivirusSignatureVersion
    $samples = @(
        @{ Name = 'original'; Hash = 'fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb' },
        @{ Name = 'normal'; Hash = 'f48ef644748694f9538ec313e998bfa0def5b3776858d41537cae07261a18387' }
    )
    foreach ($sample in $samples) {
        $name = $sample.Name
        $installer = (Resolve-Path "pair/$name").Path + '/Synara-0.9.2-x64.exe'
        $result = [ordered]@{ name = $name; expectedHash = $sample.Hash; definitionBefore = (Get-MpComputerStatus).AntivirusSignatureVersion }
        try {
            Assert-NotExcluded $installer "$evidence/$name-exclusion.txt"
            $result.excluded = $false
            $output = @(& $scanner -Scan -ScanType 3 -File $installer 2>&1)
            $result.scanExit = $LASTEXITCODE
            $output | Tee-Object "$evidence/$name-scan.txt" | Write-Host
            $result.explicitNoThreats = ($output -join "`n") -match 'found no threats\.'
            if (Test-Path -LiteralPath $installer) {
                $result.hashAfter = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } catch { $result.error = $_.ToString() }
        finally {
            $result.definitionAfter = (Get-MpComputerStatus).AntivirusSignatureVersion
            $result | ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-result.json"
            Save-State $name
            if ($result.definitionBefore -ne $definition -or $result.definitionAfter -ne $definition) { $unqualified = $true }
        }
    }
} finally {
    Start-Sleep -Seconds 20
    Save-State 'final'
    @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $started } -ErrorAction SilentlyContinue) |
        Select-Object TimeCreated, Id, Message | ConvertTo-Json -Depth 6 | Set-Content "$evidence/events.json"
}
if ($unqualified) { throw 'Definitions changed during the paired comparison.' }
