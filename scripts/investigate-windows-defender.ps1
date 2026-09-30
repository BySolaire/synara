# Issue #1376: disposable GitHub-hosted VM only; never execute either sample.
# This is a diagnostic comparison, not release qualification or a clean verdict.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Run only in a disposable GitHub-hosted Windows runner.'
}
$evidence = New-Item -ItemType Directory -Path 'defender-evidence'
$started = Get-Date
function Save-State($name) {
    Get-MpComputerStatus | ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-status.json"
    Get-MpPreference | ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-preferences.json"
    @(Get-MpThreatDetection) | ConvertTo-Json -Depth 8 | Set-Content "$evidence/$name-detections.json"
    @(Get-MpThreat) | ConvertTo-Json -Depth 8 | Set-Content "$evidence/$name-threats.json"
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
    Set-MpPreference -DisableRealtimeMonitoring $false -DisableArchiveScanning $false -DisableIOAVProtection $false -DisableBehaviorMonitoring $false
    Update-MpSignature
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
    $samples = @(
        @{ Version = '0.9.1'; Hash = '893438647667a4f6aeb2929897a0131dd95e5c0686ec2958e5968cdb75f3496b' },
        @{ Version = '0.9.2'; Hash = 'fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb' }
    )
    foreach ($sample in $samples) {
        $version = $sample.Version
        $directory = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP "synara-defender-$version")
        $installer = Join-Path $directory "Synara-$version-x64.exe"
        $result = [ordered]@{ version = $version; expectedHash = $sample.Hash; startedUtc = (Get-Date).ToUniversalTime().ToString('o') }
        try {
            Invoke-WebRequest "https://github.com/Emanuele-web04/synara/releases/download/v$version/Synara-$version-x64.exe" -OutFile $installer
            $result.hashBefore = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($result.hashBefore -ne $sample.Hash) { throw 'Official installer hash mismatch.' }
            Get-AuthenticodeSignature -LiteralPath $installer | ConvertTo-Json -Depth 5 | Set-Content "$evidence/$version-signature.json"
            & $scanner -CheckExclusion -Path $installer 2>&1 | Tee-Object "$evidence/$version-exclusion.txt"
            $result.exclusionCheckExit = $LASTEXITCODE
            & $scanner -Scan -ScanType 3 -File $installer 2>&1 | Tee-Object "$evidence/$version-scan.txt"
            $result.scanExit = $LASTEXITCODE
            if (Test-Path -LiteralPath $installer) {
                $result.hashAfter = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } catch {
            $result.error = $_.ToString()
            Write-Warning "$version scan/download: $_"
        } finally {
            $result | ConvertTo-Json -Depth 6 | Set-Content "$evidence/$version-result.json"
            Save-State $version
        }
    }
} finally {
    Save-State 'final'
    @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $started } -ErrorAction SilentlyContinue) |
        Select-Object TimeCreated, Id, Message | ConvertTo-Json -Depth 6 | Set-Content "$evidence/events.json"
    Write-Output 'Review preserved scan output, threat records, status and surviving hashes; a successful job is not a clean verdict.'
}
