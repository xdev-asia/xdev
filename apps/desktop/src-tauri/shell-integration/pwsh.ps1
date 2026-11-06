# xDev shell integration for PowerShell. xDev runs this after the profile (-NoExit
# -EncodedCommand); the profile is never changed. Works on Windows PowerShell 5.1 and later.
if (-not $global:__xdevSi) {
  $global:__xdevSi = $true
  $global:__xdevFirst = $true
  $global:__xdevUserPrompt = $function:prompt

  function global:prompt {
    $ok = $?
    $last = $global:LASTEXITCODE
    $e = [char]27
    $b = [char]7
    $out = ''
    # OSC 133 D: the last command's exit code, from its process when it had one.
    if (-not $global:__xdevFirst) {
      $code = if ($ok) { 0 } elseif ($last -is [int] -and $last -ne 0) { $last } else { 1 }
      $out += "$e]133;D;$code$b"
    }
    $global:__xdevFirst = $false
    # OSC 7: the folder as a file URL, for a folder on disk.
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
      $parts = ($loc.ProviderPath -replace '\\', '/') -split '/' | ForEach-Object {
        if ($_ -match '^[A-Za-z]:$') { $_ } else { [uri]::EscapeDataString($_) }
      }
      $path = $parts -join '/'
      if (-not $path.StartsWith('/')) { $path = '/' + $path }
      $out += "$e]7;file://$([Environment]::MachineName)$path$b"
    }
    $text = if ($global:__xdevUserPrompt) { & $global:__xdevUserPrompt } else { "PS $loc$('>' * ($nestedPromptLevel + 1)) " }
    $global:LASTEXITCODE = $last
    "$out$e]133;A$b$text$e]133;B$b"
  }

  # OSC 133 C when a line is run, through PSReadLine's read function when it is loaded.
  if (Test-Path Function:\PSConsoleHostReadLine) {
    $global:__xdevReadLine = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      $line = & $global:__xdevReadLine
      [Console]::Write("$([char]27)]133;C$([char]7)")
      $line
    }
  }
}
