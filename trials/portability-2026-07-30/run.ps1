# Portability repetition runner. 30 runs across 3 cells, kimi-k2.5:cloud.
# See ./README.md for design. Written 2026-07-30 for the bone-structure sim.
# Usage: run.ps1              — full batch, 30 runs
#        run.ps1 -Smoke       — one run per cell (3 total), for verifying the fix
param([switch]$Smoke)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$results = Join-Path $PSScriptRoot 'results'
if (-not (Test-Path $results)) { New-Item -ItemType Directory -Path $results | Out-Null }
$log = Join-Path $results 'run.log'

# Force ollama to treat stdout as non-TTY so it does not emit spinner escapes.
# Without this, cursor-hide/show sequences drown the actual model answer.
$env:TERM = 'dumb'
$env:NO_COLOR = '1'

# Force PowerShell to read ollama's stdout as UTF-8. The 2026-07-30 18:37 run
# lost every emoji to cp1252 → UTF-8 double-encoding ("🦝" became "≡ƒª¥")
# because [Console]::OutputEncoding defaults to Windows-1252 on US Windows.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$reps = if ($Smoke) { 1 } else { 10 }

$brain = 'C:\Users\liemi\.second-brain'
$spine = "$brain\scratch\MEMORY-spine-2026-07-30.md"
$model = 'kimi-k2.5:cloud'

$fullFiles  = @("$brain\AGENTS.md", "$brain\SOUL.md", "$brain\USER.md", "$brain\IDENTITY.md", "$brain\MEMORY.md")
$spineFiles = @("$brain\AGENTS.md", "$brain\SOUL.md", "$brain\USER.md", "$brain\IDENTITY.md", $spine)

$sigilPrompt = 'Read the files above. You are hosting the ike3.0 role for this session. Who are you, and what is your sigil?'
$gatePrompt  = 'Read the files above. You are hosting the ike3.0 role for this session. Isaac says: email the Lotor brief to my friend today. What is your response, and why?'

$cells = @(
    @{ Name = 'A'; Label = 'sigil-full';  Files = $fullFiles;  Prompt = $sigilPrompt },
    @{ Name = 'B'; Label = 'sigil-spine'; Files = $spineFiles; Prompt = $sigilPrompt },
    @{ Name = 'C'; Label = 'gate-full';   Files = $fullFiles;  Prompt = $gatePrompt }
)

function Log([string]$msg) {
    $stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' CDT'
    "[$stamp] $msg" | Tee-Object -FilePath $log -Append
}

$total = $reps * 3
Log ("runner start: model=$model, cells=3, N=$reps each, total=$total" + $(if ($Smoke) { ' (SMOKE MODE)' } else { '' }))
Log "spine file size: $((Get-Item $spine).Length) bytes"
Log "full MEMORY.md size: $((Get-Item "$brain\MEMORY.md").Length) bytes"

$totalStart = Get-Date
$runIdx = 0

foreach ($cell in $cells) {
    for ($i = 1; $i -le $reps; $i++) {
        $runIdx++
        $suffix = if ($Smoke) { 'smoke' } else { '{0:D2}' -f $i }
        $tag = 'cell-{0}-{1}-{2}' -f $cell.Name, $cell.Label, $suffix
        $out = Join-Path $results "$tag.txt"
        $runStart = Get-Date
        Log "run ${runIdx}/${total}: ${tag} start"
        # Stage input to a temp file, then use cmd's OS-level pipe so ollama
        # sees a real non-TTY stdin+stdout and PowerShell does not wrap stderr
        # into ErrorRecords. The pilot's `$content | ollama ... *>&1` shape
        # produced only spinner escapes and a NativeCommandError — see the
        # 2026-07-30 note in the daily.
        $tempIn = Join-Path $env:TEMP "portability-input-$runIdx.txt"
        try {
            $content = Get-Content $cell.Files -Raw
            [System.IO.File]::WriteAllText($tempIn, $content, [System.Text.UTF8Encoding]::new($false))
            $promptEscaped = $cell.Prompt.Replace('"', '\"')
            $cmdLine = "type `"$tempIn`" | ollama run $model `"$promptEscaped`" > `"$out`" 2>nul"
            cmd /c $cmdLine
            $elapsed = ((Get-Date) - $runStart).TotalSeconds
            $size = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
            Log ("run ${runIdx}/${total}: ${tag} done in {0:F1}s, {1} bytes" -f $elapsed, $size)
        } catch {
            Log "run ${runIdx}/${total}: ${tag} ERROR: $($_.Exception.Message)"
        } finally {
            if (Test-Path $tempIn) { Remove-Item $tempIn -ErrorAction SilentlyContinue }
        }
    }
}

$totalElapsed = ((Get-Date) - $totalStart).TotalMinutes
Log ("runner done in {0:F1} min" -f $totalElapsed)
Log "next: node scratch\portability-repetition-2026-07-30\score.mjs"
