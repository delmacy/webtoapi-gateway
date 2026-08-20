param(
    [string]$GatewayUrl = "http://127.0.0.1:3456",
    [string]$Provider = "webtoapi",
    [string]$WorkDir = (Get-Location).Path,
    [int]$TimeoutSec = 180,
    [switch]$SkipAgentic
)

$ErrorActionPreference = "Stop"

function Get-GatewayModels {
    try {
        $response = Invoke-RestMethod -Uri "$GatewayUrl/v1/models" -Method Get -TimeoutSec 15
        return @($response.data | ForEach-Object { $_.id })
    }
    catch {
        throw "Falha ao consultar $GatewayUrl/v1/models : $($_.Exception.Message)"
    }
}

function Quote-PowerShellLiteral {
    param([string]$Value)

    if ($null -eq $Value) { return "''" }
    return "'" + ($Value -replace "'", "''") + "'"
}

function Resolve-OpenCodeCommand {
    $cmd = Get-Command opencode -ErrorAction Stop | Select-Object -First 1
    $path = $cmd.Source
    if (-not $path) { $path = $cmd.Path }
    if (-not $path) { $path = $cmd.Definition }
    if (-not $path) {
        throw "Nao foi possivel resolver o caminho do comando opencode."
    }
    return $path
}

function Invoke-OpenCodeTest {
    param(
        [string]$Model,
        [string]$Prompt,
        [string]$Stage,
        [string]$OpenCodePath
    )

    $modelRef = "$Provider/$Model"
    Write-Host ""
    Write-Host "[$Model] $Stage"
    Write-Host ("-" * 70)

    # On Windows, opencode is commonly installed as an npm/Bun .cmd shim.
    # ProcessStartInfo with UseShellExecute=false cannot execute a .cmd shim
    # directly. Launch a child PowerShell and invoke the resolved command with
    # the call operator; this works for .cmd, .ps1, and .exe installations.
    $childPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $quotedOpenCode = Quote-PowerShellLiteral $OpenCodePath
    $quotedPrompt = Quote-PowerShellLiteral $Prompt
    $quotedModel = Quote-PowerShellLiteral $modelRef
    $command = "& $quotedOpenCode run $quotedPrompt --model $quotedModel"

    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $childPowerShell
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $startedAt = Get-Date

    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            try { $process.Kill() } catch {}
            $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
            Write-Host "TIMEOUT: $model / $Stage apos ${TimeoutSec}s" -ForegroundColor Yellow
            return [PSCustomObject]@{
                Model    = $Model
                Stage    = $Stage
                Passed   = $false
                ExitCode = $null
                Seconds  = $elapsed
                Output   = ""
                Error    = "TIMEOUT apos ${TimeoutSec}s"
            }
        }

        $process.WaitForExit()
        $stdout = $stdoutTask.Result.Trim()
        $stderr = $stderrTask.Result.Trim()
        $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)

        if ($stdout) { Write-Host $stdout }
        if ($stderr) { Write-Host $stderr -ForegroundColor DarkYellow }

        $passed = ($process.ExitCode -eq 0)
        if (-not $passed -and -not $stdout -and -not $stderr) {
            Write-Host "OpenCode encerrou com exit code $($process.ExitCode), sem stdout/stderr." -ForegroundColor Yellow
        }

        return [PSCustomObject]@{
            Model    = $Model
            Stage    = $Stage
            Passed   = $passed
            ExitCode = $process.ExitCode
            Seconds  = $elapsed
            Output   = $stdout
            Error    = $stderr
        }
    }
    catch {
        $message = $_.Exception.Message
        Write-Host "ERRO AO INICIAR OPENCODE: $message" -ForegroundColor Red
        return [PSCustomObject]@{
            Model    = $Model
            Stage    = $Stage
            Passed   = $false
            ExitCode = $null
            Seconds  = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
            Output   = ""
            Error    = $message
        }
    }
}

Write-Host ""
Write-Host "=== WebToAPI progressive model test ==="
Write-Host "Gateway : $GatewayUrl"
Write-Host "WorkDir : $WorkDir"
Write-Host ""

$openCodePath = Resolve-OpenCodeCommand
Write-Host "OpenCode : $openCodePath"
Write-Host ""

# Fail fast before iterating over every model if OpenCode itself cannot be
# launched in this environment.
Write-Host "Validando launcher do OpenCode..."
$probeCommand = "& $(Quote-PowerShellLiteral $openCodePath) --version"
$probeEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeCommand))
$probeOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $probeEncoded 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao iniciar OpenCode pelo launcher resolvido '$openCodePath': $($probeOutput -join ' ')"
}
Write-Host "OpenCode launcher OK: $($probeOutput -join ' ')"
Write-Host ""

$models = Get-GatewayModels
if (-not $models -or $models.Count -eq 0) {
    throw "Nenhum modelo retornado por /v1/models"
}

Write-Host "Modelos encontrados: $($models.Count)"
foreach ($model in $models) { Write-Host "  - $model" }

$results = New-Object System.Collections.Generic.List[object]

foreach ($model in $models) {
    Write-Host ""
    Write-Host "======================================================================"
    Write-Host "MODEL: $model"
    Write-Host "======================================================================"

    $level1 = Invoke-OpenCodeTest -Model $model -Stage "LEVEL 1 - Basic chat" -Prompt "Responda somente OK" -OpenCodePath $openCodePath
    $results.Add($level1)
    if (-not $level1.Passed) {
        Write-Host "FAIL: $model falhou no LEVEL 1. Pulando proximos niveis."
        continue
    }

    $level2 = Invoke-OpenCodeTest -Model $model -Stage "LEVEL 2 - Read tool" -Prompt "Leia o arquivo package.json deste diretorio e responda somente com o valor do campo name, se existir." -OpenCodePath $openCodePath
    $results.Add($level2)
    if (-not $level2.Passed) {
        Write-Host "FAIL: $model falhou no LEVEL 2. Pulando teste agentic."
        continue
    }

    if ($SkipAgentic) { continue }

    $level3 = Invoke-OpenCodeTest -Model $model -Stage "LEVEL 3 - Agentic validation" -Prompt "Leia o package.json deste projeto, escolha uma validacao segura que nao modifique arquivos, execute essa validacao e responda somente com o comando executado e se passou. Nao altere arquivos." -OpenCodePath $openCodePath
    $results.Add($level3)
}

Write-Host ""
Write-Host "======================================================================"
Write-Host "SUMMARY"
Write-Host "======================================================================"
Write-Host ""

$summary = foreach ($model in $models) {
    $r = @($results | Where-Object { $_.Model -eq $model })
    $l1 = $r | Where-Object Stage -Like "LEVEL 1*"
    $l2 = $r | Where-Object Stage -Like "LEVEL 2*"
    $l3 = $r | Where-Object Stage -Like "LEVEL 3*"

    [PSCustomObject]@{
        Model   = $model
        Chat    = if ($l1) { if ($l1.Passed) { "PASS" } else { "FAIL" } } else { "-" }
        Read    = if ($l2) { if ($l2.Passed) { "PASS" } else { "FAIL" } } else { "-" }
        Agentic = if ($l3) { if ($l3.Passed) { "PASS" } else { "FAIL" } } else { "-" }
    }
}

$summary | Format-Table -AutoSize

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $WorkDir "webtoapi-model-test-$timestamp.json"

[PSCustomObject]@{
    Timestamp    = (Get-Date).ToString("o")
    Gateway      = $GatewayUrl
    WorkDir      = $WorkDir
    OpenCodePath = $openCodePath
    Models       = $models
    Summary      = $summary
    Results      = $results
} | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8

Write-Host ""
Write-Host "Relatorio salvo em:"
Write-Host $reportPath
Write-Host ""
