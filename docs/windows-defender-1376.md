# Windows Defender investigation: issue #1376

Evidence collected on 2026-09-30 for [issue #1376](https://github.com/Emanuele-web04/synara/issues/1376), from main `529ad049cb106c998010f5400189515008997aa4`. This is an investigation and qualification procedure, not a confirmed malware verdict, false-positive determination, or shipped fix. No Windows reproduction was available.

## Verified evidence

The reporter's screenshot shows `Trojan:Win32/Kepavl!rfn`, status **Removed**, on `Synara-0.9.2-x64.exe.crdownload` on 2026-09-29. The reported environment is Windows 11 24H2 build 26100.9457 with Helium. The screenshot does not provide the downloaded bytes' hash, Defender engine/definition versions, or a detected inner component. The browser version is also missing.

Both complete installers were downloaded from the official releases, hashed locally, and matched against GitHub's asset digest and the corresponding Windows provenance. The release source's `bun.lock` hashes also match provenance. This establishes which public artifacts were inspected; it does not prove the reporter received identical complete bytes or establish their safety.

| Artifact                                                                                                       | Source commit                              | Bytes     | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------- | ------------------------------------------------------------------ |
| [Synara-0.9.2-x64.exe](https://github.com/Emanuele-web04/synara/releases/download/v0.9.2/Synara-0.9.2-x64.exe) | `a33435c18474eb7816582004e45f87382965ac8d` | 225688617 | `fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb` |
| [Synara-0.9.1-x64.exe](https://github.com/Emanuele-web04/synara/releases/download/v0.9.1/Synara-0.9.1-x64.exe) | `eaa61eded31b6755d4f30ba8eabc5d905cf817cb` | 225595797 | `893438647667a4f6aeb2929897a0131dd95e5c0686ec2958e5968cdb75f3496b` |

Both [v0.9.2 provenance](https://github.com/Emanuele-web04/synara/releases/download/v0.9.2/artifact-win-x64.provenance.json) and [v0.9.1 provenance](https://github.com/Emanuele-web04/synara/releases/download/v0.9.1/artifact-win-x64.provenance.json) record `unsigned-explicit-release`. Both installers have an empty PE certificate directory. Lack of signing is not new in v0.9.2 and does not establish the cause of this antivirus detection. There is no independently verified clean Defender result for v0.9.1 either.

The [v0.9.2 Windows release job](https://github.com/Emanuele-web04/synara/actions/runs/36159536991/job/108154522199) passed packaging, provenance, and packaged startup. It did not record a Defender scan. These checks do not qualify the installer against the reported detection. Current release tooling already supports Azure Trusted Signing and verifies the expected publisher, certificate subject, signature status, and timestamp when signing is enabled. No credential or signing-policy change was made for this investigation.

## Static comparison

7-Zip 24.09 extracted NSIS and its `$PLUGINSDIR/app-64.7z` payload without running either installer. The extraction tool archive SHA-256 was `496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1`, matching electron-builder's pinned Darwin toolset checksum. The comparison covers extracted `.exe`, `.dll`, and `.node` files with PE magic, including NSIS plugins and the uninstaller. All such entries in `app.asar` are marked unpacked. It is not a malware scan or an audit of every JavaScript file.

There are 49 extracted PE files in v0.9.1 and 48 in v0.9.2: 37 identical hashes, nine changed hashes, two added paths, and three removed paths. The [comparison manifest](evidence/windows-defender-1376.json) records those differences and selected unchanged component hashes.

| Component                                                                                       | Observed difference                                                                                 |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Electron 43.4.1, electron-builder 26.15.3, node-pty 1.1.0, Claude SDK 0.3.259                   | Versions unchanged in release lockfiles                                                             |
| NSIS plugins, Electron DLLs, Claude executable, node-pty prebuilt helpers, rookie-cookies addon | Byte-identical at matching paths                                                                    |
| `Synara.exe`, uninstaller, six locally built native addon/helper files                          | Hashes changed; hash differences alone do not establish functional differences or a detection cause |
| Bundled `@esbuild/win32-x64/esbuild.exe`                                                        | Version changed from 0.28.1 to 0.28.2                                                               |
| pi-tui Windows addons                                                                           | Two `win32-console-mode.node` paths replaced by two `win32-platform.node` paths, for x64 and arm64  |
| Clipboard addon                                                                                 | `@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node` removed                      |

The screenshot only names the outer download. It cannot distinguish an installer/container heuristic, an inner executable/addon, or a definition/cloud-classification change. Changing compression, replacing NSIS, removing runtime helpers, or adding a signature would be speculative remediation without a paired Defender result or Microsoft determination.

## Qualification on an isolated Windows VM

Use a disposable Windows 11 VM with Defender active, no production data, and no exclusions covering the samples or scanning tools. Do not execute either installer during this investigation, restore quarantined samples, allow the threat, disable protection, or add exclusions. If Defender removes a sample during download, retain the detection evidence and stop that attempt; a missing file is not a clean result.

Run an elevated PowerShell session. Record the original definition versions and attempt the browser download first, so that an update does not erase the initial conditions. Then update security intelligence normally and repeat, recording both results. Record the exact Windows and browser versions, download URL, UTC time, Defender status, and threat details. Compare v0.9.1, v0.9.2, and any candidate using the same engine/definitions and VM conditions; a definition update is a separate experiment from a packaging change.

The following commands collect evidence locally. They do not submit files or change security policy. Choose a new evidence directory per attempt. Review logs before sharing because they can contain local paths and machine identifiers.

```powershell
$ErrorActionPreference = 'Stop'
$evidence = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('synara-defender-' + [guid]::NewGuid()))
$started = Get-Date
(Get-Date).ToUniversalTime().ToString('o') | Out-File (Join-Path $evidence 'started-utc.txt')
Get-ComputerInfo -Property WindowsProductName, WindowsVersion, OsBuildNumber |
    ConvertTo-Json | Set-Content (Join-Path $evidence 'windows.json')
Get-MpComputerStatus | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $evidence 'defender-before.json')
Get-MpPreference | Select-Object DisableArchiveScanning, MAPSReporting, SubmitSamplesConsent, ExclusionPath, ExclusionExtension, ExclusionProcess |
    ConvertTo-Json -Depth 4 | Set-Content (Join-Path $evidence 'scan-settings.json')
```

After the browser attempt, capture its result and the detection records even if download failed:

```powershell
Get-MpThreatDetection | ConvertTo-Json -Depth 6 |
    Set-Content (Join-Path $evidence 'detections.json')
Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $started } |
    Select-Object TimeCreated, Id, Message | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $evidence 'events.json')
```

If the complete v0.9.2 file survives, set its actual path below and verify the hash before scanning. Find the newest installed Defender platform's `MpCmdRun.exe` (fall back to `%ProgramFiles%\Windows Defender\MpCmdRun.exe` only if no platform copy exists). Verify that the sample path is not excluded with `-CheckExclusion -Path`; retain its output and check the result before scanning.

```powershell
$sample = 'C:\samples\Synara-0.9.2-x64.exe'
$expected = 'fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb'
if ((Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash -ne $expected) {
    throw 'The sample does not match the official v0.9.2 installer.'
}
Get-AuthenticodeSignature -LiteralPath $sample | Format-List * |
    Out-File (Join-Path $evidence 'signature.txt')
# Replace this with the actual newest installed platform directory.
$mpcmd = 'C:\ProgramData\Microsoft\Windows Defender\Platform\<version>\MpCmdRun.exe'
& $mpcmd -CheckExclusion -Path $sample 2>&1 |
    Out-File (Join-Path $evidence 'exclusion-check.txt')
# Continue only after verifying the path is not excluded.
& $mpcmd -Scan -ScanType 3 -File $sample 2>&1 |
    Out-File (Join-Path $evidence 'scan.txt')
$scanExit = $LASTEXITCODE
$scanExit | Set-Content (Join-Path $evidence 'scan-exit.txt')
Get-MpComputerStatus | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $evidence 'defender-after.json')
if (Test-Path -LiteralPath $sample) {
    Get-FileHash -LiteralPath $sample -Algorithm SHA256 |
        ConvertTo-Json | Set-Content (Join-Path $evidence 'hash-after.json')
}
```

Recapture detections and events after the scan. Microsoft documents that exit code **0 can also mean a threat was found and remediated**, and code **2 can mean a detection or a scan error**. Do not interpret either in isolation. A qualified result needs active antivirus/real-time protection, no applicable exclusion, completed scan output, the surviving expected hash, and no relevant detection/remediation. Archive scanning settings must be recorded; a scan which omits the embedded payload does not qualify its components. A complete-file scan still needs a separate browser-download reproduction of the `.crdownload` path.

If the outer installer is detected and the sample remains available, extract it with a trusted archive tool in the VM, without running its stub. Inventory and scan the NSIS plugins, `$PLUGINSDIR/app-64.7z`, extracted application, and unpacked native helpers separately. Hash components before scans and retain removals as detections. If quarantine prevents extraction, use the static inventory to plan independent component scans; do not bypass Defender to recover the file. Scan `app.asar` separately from executable/addon files and report its archive-format coverage as unverified unless established. Record the exact detected relative path and hash; do not infer it from the outer filename. Retain the current definitions for the baseline/candidate pair.

Commands and interpretation follow Microsoft's [MpCmdRun reference](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus), [Get-MpComputerStatus](https://learn.microsoft.com/en-us/powershell/module/defender/get-mpcomputerstatus), and [Get-MpThreatDetection](https://learn.microsoft.com/en-us/powershell/module/defender/get-mpthreatdetection). These commands were checked against the documentation but were not executed on Windows in this investigation. If evidence collection fails, retain the error as an unqualified attempt rather than treating missing records as a clean result.

## Prepared Microsoft analysis request

Submission requires separate authorization. Use the [Microsoft Security Intelligence submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) as **Software developer**, selecting **Microsoft Defender Antivirus (Windows 11)**. The portal currently states a 50 MB file limit and asks for specific files rather than large installers. This installer is 225688617 bytes: do not assume it can be uploaded directly. First identify a detected component small enough to submit, or obtain Microsoft's approved route for the larger sample. Do not submit an unrelated small file as a substitute.

Prepared context, to supplement with actual engine/definition versions, detected component hash, reproduction output, and contact/company details:

> A user reports Microsoft Defender Antivirus removing Synara-0.9.2-x64.exe.crdownload as Trojan:Win32/Kepavl!rfn on Windows 11 24H2 build 26100.9457 while downloading the official release in Helium. The complete official installer is 225688617 bytes, SHA-256 fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb, source a33435c18474eb7816582004e45f87382965ac8d. The official installer and Windows provenance are linked in this dossier. Both v0.9.1 and v0.9.2 were published unsigned. We have verified artifact hashes and statically compared extracted native files on macOS, but have not independently reproduced the detection or established which component triggers it. Please analyze the classification. We are not claiming a confirmed false positive. No sample has been submitted yet.

## Remaining acceptance evidence

The issue remains unresolved pending independent Windows/Defender results and identification of a detected component or Microsoft's determination. Once that evidence justifies a repair, qualify the baseline and repaired installer under matched conditions, then repeat the browser download with Defender active. Signed-artifact qualification, if selected, must use the existing Azure signing/provenance path; signing alone is not an antivirus acceptance result. A repair is not delivered to users until the qualified artifact is released through the authorized release workflow.
