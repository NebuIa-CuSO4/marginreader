$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($focused) {
    $pattern = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($pattern) {
      $ranges = $pattern.GetSelection()
      $parts = @()
      foreach ($range in $ranges) {
        $value = $range.GetText(-1)
        if ($value) { $parts += $value.Trim() }
      }
      $text = ($parts | Where-Object { $_ }) -join "`n"
      if ($text) {
        $text
        exit 0
      }
    }
  }
} catch {
  # Fall back to the clipboard method in the app.
}

exit 2
