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

function Get-HttpErrorText {
    param($ErrorRecord)

    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return [string]$ErrorRecord.ErrorDetails.Message
    }

    try {
        $response = $ErrorRecord.Exception.Response
        if ($response -and $response.GetResponseStream()) {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
    }
    catch {}

    return [string]$ErrorRecord.Exception.Message
}

function Invoke-DirectChatTest {
    param([string]$Model)

    $stage = "LEVEL 1 - Basic chat"
    Write-Host ""
    Write-Host "[$Model] $stage"
    Write-Host ("-" * 70)

    $startedAt = Get-Date
    $body = @{
        model = $Model
        stream = $false
        messages = @(
            @{ role = "user"; content = "Responda somente OK" }
        )
    } | ConvertTo-Json -Depth 6

    try {
        $response = Invoke-RestMethod `
            -Uri "$GatewayUrl/v1/chat/completions" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec $TimeoutSec

        $text = ""
        if ($response.choices -and $response.choices.Count -gt 0) {
            $text = [string]$response.choices[0].message.content
        }
        $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)

        if ($text) { Write-Host $text }
        else { Write-Host "Resposta recebida, mas sem texto em choices[0].message.content" -ForegroundColor Yellow }

        return [PSCustomObject]@{
            Model       = $Model
            Stage       = $stage
            Passed      = -not [string]::IsNullOrWhiteSpace($text)
            Unavailable = $false
            ExitCode    = 0
            Seconds     = $elapsed
            Output      = $text
            Error       = ""
        }
    }
    catch {
        $message = Get-HttpErrorText $_
        $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
        $unavailable = $message -match "model_not_available|model isn't available|model is not available|not available right now"

        if ($unavailable) {
            Write-Host "UNAVAILABLE: $message" -ForegroundColor Yellow
        }
        else {
            Write-Host "FAIL: $message" -ForegroundColor Red
        }

        return [PSCustomObject]@{
            Model       = $Model
            Stage       = $stage
            Passed      = $false
            Unavailable = $unavailable
            ExitCode    = $null
            Seconds     = $elapsed
            Output      = ""
            Error       = $message
        }
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
                Model       = $Model
                Stage       = $Stage
                Passed      = $false
                Unavailable = $false
                ExitCode    = $null
                Seconds     = $elapsed
                Output      = ""
                Error       = "TIMEOUT apos ${TimeoutSec}s"
            }
        }

        $process.WaitForExit()
        $stdout = $stdoutTask.Result.Trim()
        $stderr = $stderrTask.Result.Trim()
        $elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)

        if ($stdout) { Write-Host $stdout }
        if ($stderr) { Write-Host $stderr -ForegroundColor DarkYellow }

        $combined = "$stdout`n$stderr"
        $unavailable = $combined -match "model_not_available|model isn't available|model is not available|not available right now"
        $passed = ($process.ExitCode -eq 0)

        return [PSCustomObject]@{
            Model       = $Model
            Stage       = $Stage
            Passed      = $passed
            Unavailable = $unavailable
            ExitCode    = $process.ExitCode
            Seconds     = $elapsed
            Output      = $stdout
            Error       = $stderr
        }
    }
    catch {
        $message = $_.Exception.Message
        Write-Host "ERRO AO INICIAR OPENCODE: $message" -ForegroundColor Red
        return [PSCustomObject]@{
            Model       = $Model
            Stage       = $Stage
            Passed      = $false
            Unavailable = $false
            ExitCode    = $null
            Seconds     = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
            Output      = ""
            Error       = $message
        }
    }
}

function Format-TestState {
    param($Result)

    if (-not $Result) { return "-" }
    if ($Result.Unavailable) { return "UNAVAILABLE" }
    if ($Result.Passed) { return "PASS" }
    return "FAIL"
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
Write-Host ""

$openCodePath = Resolve-OpenCodeCommand
Write-Host "OpenCode : $openCodePath"
Write-Host "Validando launcher do OpenCode..."
$probeCommand = "& $(Quote-PowerShellLiteral $openCodePath) --version"
$probeEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeCommand))
$probeOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $probeEncoded 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao iniciar OpenCode pelo launcher resolvido '$openCodePath': $($probeOutput -join ' ')"
}
Write-Host "OpenCode launcher OK: $($probeOutput -join ' ')"

$results = New-Object System.Collections.Generic.List[object]

foreach ($model in $models) {
    Write-Host ""
    Write-Host "======================================================================"
    Write-Host "MODEL: $model"
    Write-Host "======================================================================"

    # LEVEL 1 intentionally bypasses OpenCode. This prevents OpenCode retries
    # from hammering an unavailable upstream model and verifies the gateway
    # itself with exactly one basic request.
    $level1 = Invoke-DirectChatTest -Model $model
    $results.Add($level1)
    if (-not $level1.Passed) {
        if ($level1.Unavailable) {
            Write-Host "SKIP: $model nao esta disponivel upstream."
        }
        else {
            Write-Host "FAIL: $model falhou no LEVEL 1. Pulando proximos niveis."
        }
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
        Chat    = Format-TestState $l1
        Read    = Format-TestState $l2
        Agentic = Format-TestState $l3
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
