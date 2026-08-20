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

function Quote-ProcessArgument {
    param([string]$Value)

    if ($null -eq $Value) { return '""' }
    # The prompts used by this smoke test do not contain shell metacharacters.
    # Escape embedded quotes so ProcessStartInfo.Arguments also works on
    # Windows PowerShell 5.1, where ProcessStartInfo.ArgumentList is absent.
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-OpenCodeTest {
    param(
        [string]$Model,
        [string]$Prompt,
        [string]$Stage
    )

    $modelRef = "$Provider/$Model"
    Write-Host ""
    Write-Host "[$Model] $Stage"
    Write-Host ("-" * 70)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "opencode"
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    # ProcessStartInfo.ArgumentList only exists on newer .NET versions.
    # Use the classic Arguments property for Windows PowerShell 5.1 compatibility.
    $quotedPrompt = Quote-ProcessArgument $Prompt
    $quotedModel = Quote-ProcessArgument $modelRef
    $psi.Arguments = "run $quotedPrompt --model $quotedModel"

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $startedAt = Get-Date

    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            try { $process.Kill() } catch {}
            return [PSCustomObject]@{
                Model    = $Model
                Stage    = $Stage
                Passed   = $false
                ExitCode = $null
                Seconds  = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
                Output   = ""
                Error    = "TIMEOUT apos ${TimeoutSec}s"
            }
        }

        # Ensure async stdout/stderr reads are fully drained before reading Result.
        $process.WaitForExit()
        $stdout = $stdoutTask.Result.Trim()
        $stderr = $stderrTask.Result.Trim()
        $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)

        if ($stdout) { Write-Host $stdout }
        if ($stderr) { Write-Host $stderr }

        return [PSCustomObject]@{
            Model    = $Model
            Stage    = $Stage
            Passed   = ($process.ExitCode -eq 0)
            ExitCode = $process.ExitCode
            Seconds  = $elapsed
            Output   = $stdout
            Error    = $stderr
        }
    }
    catch {
        return [PSCustomObject]@{
            Model    = $Model
            Stage    = $Stage
            Passed   = $false
            ExitCode = $null
            Seconds  = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
            Output   = ""
            Error    = $_.Exception.Message
        }
    }
}

Write-Host ""
Write-Host "=== WebToAPI progressive model test ==="
Write-Host "Gateway : $GatewayUrl"
Write-Host "WorkDir : $WorkDir"
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

    $level1 = Invoke-OpenCodeTest -Model $model -Stage "LEVEL 1 - Basic chat" -Prompt "Responda somente OK"
    $results.Add($level1)
    if (-not $level1.Passed) {
        Write-Host "FAIL: $model falhou no LEVEL 1. Pulando proximos niveis."
        continue
    }

    $level2 = Invoke-OpenCodeTest -Model $model -Stage "LEVEL 2 - Read tool" -Prompt "Leia o arquivo package.json deste diretorio e responda somente com o valor do campo name, se existir."
    $results.Add($level2)
    if (-not $level2.Passed) {
        Write-Host "FAIL: $model falhou no LEVEL 2. Pulando teste agentic."
        continue
    }

    if ($SkipAgentic) { continue }

    $level3 = Invoke-OpenCodeTest -Model $model -Stage "LEVEL 3 - Agentic validation" -Prompt "Leia o package.json deste projeto, escolha uma validacao segura que nao modifique arquivos, execute essa validacao e responda somente com o comando executado e se passou. Nao altere arquivos."
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
    Timestamp = (Get-Date).ToString("o")
    Gateway   = $GatewayUrl
    WorkDir   = $WorkDir
    Models    = $models
    Summary   = $summary
    Results   = $results
} | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8

Write-Host ""
Write-Host "Relatorio salvo em:"
Write-Host $reportPath
Write-Host ""
