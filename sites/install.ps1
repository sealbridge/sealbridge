param([switch]$Uninstall, [switch]$NoProfile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Sealbridge'
$nodeVersion = '22.22.0'
$package = 'sealbridge@0.2.2'
$nodeDir = Join-Path $root 'node'
$npmDir = Join-Path $root 'npm'

function Get-SealbridgeNode {
    param([string]$Prefix)
    # npm's Windows shims prefer node.exe beside the shim, then search PATH.
    $node = Join-Path $Prefix 'node.exe'
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (!$command) { return $null }
        $node = $command.Source
    }
    try {
        $version = & $node -p process.versions.node
        if ($LASTEXITCODE -ne 0) { return $null }
        $version = "$version".Trim()
        $major = 0
        if ($version -notmatch '^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or ![int]::TryParse($Matches[1], [ref]$major)) { return $null }
        $resolvedPath = & $node -p process.execPath
        if ($LASTEXITCODE -ne 0 -or !$resolvedPath) { return $null }
        return [PSCustomObject]@{ Path = "$resolvedPath".Trim(); Version = $version; Supported = $major -ge 22 }
    } catch { return $null }
}

function Get-SealbridgeRuntime {
    param([string]$Prefix)
    $node = Get-SealbridgeNode -Prefix $Prefix
    # On Windows, co-installed npm has node_modules/npm/bin/npm-cli.js next
    # to the resolved node.exe. Never borrow npm.cmd from another PATH entry:
    # its adjacent node.exe could differ. Invoke the CLI with our exact Node.
    $npm = $null
    $state = 'not checked (Node missing, failed, or older than 22)'
    $usable = $false
    if ($node -and $node.Supported) {
        $npm = Join-Path (Split-Path -Parent $node.Path) 'node_modules/npm/bin/npm-cli.js'
        $state = "npm missing beside $($node.Path): $npm"
        if (Test-Path -LiteralPath $npm -PathType Leaf) {
            $state = "npm failed: $npm"
            try {
                $version = & $node.Path $npm --version 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $state = "npm returned an invalid version: $npm"
                    if ("$version".Trim() -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
                        $usable = $true
                        $state = "$npm ($version)"
                    }
                }
            } catch { $state = "npm failed: $npm" }
        }
    }
    return [PSCustomObject]@{ Node = $node; Npm = $npm; NpmState = $state; Usable = $usable }
}

function Format-SealbridgeRuntime {
    param($Runtime)
    if (!$Runtime) { return 'node not checked; npm not checked' }
    $node = if ($Runtime.Node) { "$($Runtime.Node.Path) ($($Runtime.Node.Version))" } else { 'missing or failed version query' }
    return "node $node; npm: $($Runtime.NpmState)"
}

function Get-SealbridgeFileHash {
    param([string]$Path)
    # Use .NET directly so hashing does not depend on module autoloading when
    # Windows PowerShell inherits a module search path from PowerShell 7.
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
        finally { $sha256.Dispose() }
    } finally { $stream.Dispose() }
}

# Set native-command handling explicitly for consistent exit-code checks in
# Windows PowerShell 5.1 and PowerShell 7, including nonzero npm probes.
$PSNativeCommandUseErrorActionPreference = $false
$selection = $null
$initialRuntime = 'not checked'

try {
    if ($Uninstall) {
        if (!(Test-Path -LiteralPath (Join-Path $root '.installer-owned'))) { throw 'No installer-owned installation found; nothing removed.' }
        $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Sealbridge'))
        if ([IO.Path]::GetFullPath($root) -ne $expected) { throw 'Unsafe uninstall path.' }
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $kept = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $nodeDir -and $_ -ne $npmDir })
        if (!$NoProfile) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User') }
        $env:Path = (@($env:Path -split ';' | Where-Object { $_ -ne $nodeDir -and $_ -ne $npmDir }) -join ';')
        Remove-Item -LiteralPath $expected -Recurse -Force
        Write-Host 'Removed Sealbridge. Your keys are preserved.'
        return
    }
    if ((Test-Path -LiteralPath $root) -and !(Test-Path -LiteralPath (Join-Path $root '.installer-owned'))) { throw 'Installation directory already exists without an ownership marker.' }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Set-Content -LiteralPath (Join-Path $root '.installer-owned') -Value 'Sealbridge installer'
    $env:Path = "$nodeDir;$npmDir;$env:Path"
    # Prefer a previously installed managed runtime on reruns. Otherwise retain
    # the npm-prefix Node preference used by the original Windows launcher.
    $prefix = if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe') -PathType Leaf) { $nodeDir } else { $npmDir }
    $selection = Get-SealbridgeRuntime -Prefix $prefix
    $initialRuntime = Format-SealbridgeRuntime $selection
    if (!$selection.Usable) {
        Write-Host "Runtime found: $initialRuntime"
        Write-Host "Installing user-local Node $nodeVersion with bundled npm."
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'x64' } else { throw 'Windows x64 or arm64 is required.' }
        $file = "node-v$nodeVersion-win-$arch.zip"
        $download = Join-Path $root ('download-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $download | Out-Null
        $archive = Join-Path $download $file
        Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$file" -OutFile $archive -UseBasicParsing
        $checksums = (Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
        $expectedHash = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $file") }) -replace '\s+.*$', ''
        if (!$expectedHash -or $expectedHash.Length -ne 64 -or (Get-SealbridgeFileHash -Path $archive) -ine $expectedHash) { throw 'Node checksum mismatch; installation stopped.' }
        # PowerShell 7 already exposes ZipFile. On .NET Framework, use full
        # assembly names so the GAC resolves them without module autoloading.
        if (!('System.IO.Compression.ZipFile' -as [type])) {
            [void][Reflection.Assembly]::Load('System.IO.Compression, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
            [void][Reflection.Assembly]::Load('System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $download)
        New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
        Copy-Item -Path (Join-Path $download "node-v$nodeVersion-win-$arch/*") -Destination $nodeDir -Recurse -Force
        $resolvedDownload = [IO.Path]::GetFullPath($download)
        if (!$resolvedDownload.StartsWith([IO.Path]::GetFullPath($root) + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe temporary path.' }
        Remove-Item -LiteralPath $resolvedDownload -Recurse -Force
        $selection = Get-SealbridgeRuntime -Prefix $nodeDir
        if (!$selection.Usable -or $selection.Node.Path -ne (Join-Path $nodeDir 'node.exe')) { throw 'Downloaded Node or its bundled npm is not usable.' }
    }
    $runtime = $selection.Node
    if ($env:SEALBRIDGE_INSTALL_TARBALL) {
        if (!(Test-Path -LiteralPath $env:SEALBRIDGE_INSTALL_TARBALL -PathType Leaf)) { throw 'Local test tarball does not exist.' }
        $package = $env:SEALBRIDGE_INSTALL_TARBALL
    }
    & $runtime.Path $selection.Npm install --global --prefix $npmDir --ignore-scripts --no-audit --no-fund $package
    if ($LASTEXITCODE -ne 0) { throw 'npm installation failed.' }
    # Pin the Windows shims to the selected Node without replacing any existing
    # node.exe (including one already in the npm prefix). npm regenerates these
    # files on reruns, so write them after each successful package installation.
    $cmdNode = if ($runtime.Path -eq (Join-Path $nodeDir 'node.exe')) { '%~dp0..\node\node.exe' } else { $runtime.Path.Replace('%', '%%') }
    $psNode = $runtime.Path.Replace("'", "''")
    foreach ($name in @('sealbridge', 'acp')) {
        $entryName = if ($name -eq 'sealbridge') { 'index' } else { 'acp' }
        $entry = "node_modules/sealbridge/dist/cli/dist/$entryName.js"
        Set-Content -LiteralPath (Join-Path $npmDir "$name.cmd") -Encoding Default -Value "@echo off`r`nsetlocal DisableDelayedExpansion`r`n`"$cmdNode`" `"%~dp0$entry`" %*`r`nexit /b %errorlevel%"
        # A BOM lets either PowerShell version read paths containing non-ASCII characters.
        [IO.File]::WriteAllText((Join-Path $npmDir "$name.ps1"), "& '$psNode' (Join-Path `$PSScriptRoot '$entry') @args`r`nexit `$LASTEXITCODE", (New-Object System.Text.UTF8Encoding $true))
    }
    Write-Host "Node.js: $($runtime.Version) ($($runtime.Path))"
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $nodeDir -and $_ -ne $npmDir })
    if (!$NoProfile) { [Environment]::SetEnvironmentVariable('Path', ((@($nodeDir, $npmDir) + $parts) -join ';'), 'User') }
    & (Join-Path $npmDir 'sealbridge.cmd') --version
    if ($LASTEXITCODE -ne 0) { throw 'Installed CLI did not start.' }
    & (Join-Path $npmDir 'sealbridge.cmd') doctor
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Installed, but doctor found an issue. Follow its fixes and rerun sealbridge doctor.' }
    Write-Host 'Installed. Run sealbridge demo. Uninstall: & ./install.ps1 -Uninstall'
} catch {
    # Error-record formatting can wrap or truncate long exceptions. Emit the
    # details separately so both shells preserve them in redirected stderr.
    [Console]::Error.WriteLine("Sealbridge installation failed: $($_.Exception.Message)")
    [Console]::Error.WriteLine("Initial runtime: $initialRuntime")
    [Console]::Error.WriteLine("Current runtime: $(Format-SealbridgeRuntime $selection)")
    [Console]::Error.WriteLine('Install Node 22 or newer with its bundled npm,')
    [Console]::Error.WriteLine('put that installation first on PATH, and rerun.')
    [Console]::Error.WriteLine('For automatic installation, check internet access to nodejs.org')
    [Console]::Error.WriteLine("and write access to $root.")
    throw 'Sealbridge installation failed. See runtime details and remediation above.'
}
