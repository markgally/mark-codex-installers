param(
    [string]$EventFile,
    [ValidatePattern('^[A-Za-z]{2,20}$')][string]$AssistantName = 'Mark',
    [string]$AudioFile,
    [switch]$PolicyOnly
)
$ErrorActionPreference = 'Stop'
function Test-WakeResult($Result, [string]$Name) {
    if (-not $Result -or $Result.Grammar.Name -ne 'wake-phrase') { return $false }
    $phrase = ($Result.Text.Trim() -replace '\s+', ' ').ToLowerInvariant()
    if ($phrase -notin @("hey $Name".ToLowerInvariant(), "hi $Name".ToLowerInvariant())) { return $false }
    if ($Result.Confidence -lt 0.80 -or $Result.Words.Count -ne 2) { return $false }
    foreach ($word in $Result.Words) {
        if ($word.Confidence -lt 0.75) { return $false }
    }
    if ($Result.Audio.Duration.TotalSeconds -lt 0.20 -or $Result.Audio.Duration.TotalSeconds -gt 2.5) { return $false }
    return $true
}
if ($PolicyOnly) { return }
if (-not $EventFile) { throw 'EventFile is required.' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Status([string]$Type, [string]$Message = '', $Result = $null) {
    $fields = @{ type = $Type; message = $Message }
    if ($Result) {
        $fields.phrase = $Result.Text
        $fields.confidence = [double]$Result.Confidence
        $fields.wordConfidences = @($Result.Words | ForEach-Object { [double]$_.Confidence })
        $fields.grammar = $Result.Grammar.Name
        $fields.duration = $Result.Audio.Duration.TotalSeconds
    }
    $record = $fields | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($EventFile, $record + "`n", $utf8)
}
$engine = $null
try {
    Add-Type -AssemblyName System.Speech
    $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    $recognizer = $recognizers | Where-Object { $_.Culture.Name -eq 'en-US' } | Select-Object -First 1
    if (-not $recognizer) {
        $recognizer = $recognizers | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'en' } | Select-Object -First 1
    }
    if (-not $recognizer) { throw 'Install an English Speech language pack in Windows Settings, then restart MARK.' }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
    $phrases = New-Object System.Speech.Recognition.Choices
    $phrases.Add([string[]]@("hey $AssistantName", "hi $AssistantName"))
    $grammar = New-Object System.Speech.Recognition.GrammarBuilder
    $grammar.Culture = $recognizer.Culture
    $grammar.Append($phrases)
    $wakeGrammar = New-Object System.Speech.Recognition.Grammar($grammar)
    $wakeGrammar.Name = 'wake-phrase'
    $engine.LoadGrammar($wakeGrammar)
    # A name by itself must have an explicit non-wake recognition path. Otherwise
    # the command grammar can fit a breath/noise plus the name to "hi <name>".
    $shortPhrases = New-Object System.Speech.Recognition.Choices
    $shortPhrases.Add([string[]]@($AssistantName, 'hey', 'hi'))
    $shortBuilder = New-Object System.Speech.Recognition.GrammarBuilder
    $shortBuilder.Culture = $recognizer.Culture
    $shortBuilder.Append($shortPhrases)
    $shortGrammar = New-Object System.Speech.Recognition.Grammar($shortBuilder)
    $shortGrammar.Name = 'incomplete-wake-phrase'
    $engine.LoadGrammar($shortGrammar)
    if ($AudioFile) {
        $engine.SetInputToWaveFile($AudioFile)
    } else {
        # Discard the tail of playback/failed voice startup before reopening input.
        Start-Sleep -Milliseconds 1200
        $engine.SetInputToDefaultAudioDevice()
    }
    Write-Status 'ready'
    while ($true) {
        $result = $engine.Recognize([TimeSpan]::FromSeconds(2))
        if ($AudioFile -and $result) { Write-Status 'sample' '' $result }
        if (Test-WakeResult $result $AssistantName) {
            Write-Status 'wake' '' $result
            break
        }
        if ($AudioFile) { break }
    }
} catch {
    Write-Status 'error' ($_.Exception.Message + ' Check Windows microphone permissions for desktop apps.')
    exit 1
} finally {
    if ($engine) { $engine.Dispose() }
}
