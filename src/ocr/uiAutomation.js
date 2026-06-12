// Windows UI Automation - 直接讀取視窗文字元素（移植自 Screenshot-OCR src/main/uiAutomation.ts）
// 繞過 OCR，100% 準確，極快速度
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

// 讀取指定區域內的所有文字元素
async function getTextFromRect(x, y, width, height) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return { success: false, text: "", elements: [], error: "Invalid coordinates" };
  }
  const safeX = Math.round(x);
  const safeY = Math.round(y);
  const safeW = Math.round(width);
  const safeH = Math.round(height);
  const script = `
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Drawing

    $rect = New-Object System.Drawing.Rectangle(${safeX}, ${safeY}, ${safeW}, ${safeH})
    $results = @()

    # Get root element
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # Create condition to find all elements
    $condition = [System.Windows.Automation.Condition]::TrueCondition

    # Walk through all elements and find those in our rect
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

    function Get-TextFromElement($element, $depth) {
      if ($depth -gt 10) { return @() }  # Limit depth to prevent infinite loops

      $results = @()
      $current = $walker.GetFirstChild($element)

      while ($current -ne $null) {
        try {
          $bounds = $current.Current.BoundingRectangle

          # Check if element is within our rect
          if ($bounds.X -ge ${safeX} -and $bounds.Y -ge ${safeY} -and
              ($bounds.X + $bounds.Width) -le (${safeX} + ${safeW}) -and
              ($bounds.Y + $bounds.Height) -le (${safeY} + ${safeH})) {

            $text = ""

            # Try value pattern first
            try {
              $valuePattern = $current.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
              if ($valuePattern -ne $null) { $text = $valuePattern.Current.Value }
            } catch {}

            # Try text pattern
            if ([string]::IsNullOrEmpty($text)) {
              try {
                $textPattern = $current.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                if ($textPattern -ne $null) { $text = $textPattern.DocumentRange.GetText(1000) }
              } catch {}
            }

            # Use name if no text found
            if ([string]::IsNullOrEmpty($text)) { $text = $current.Current.Name }

            if (-not [string]::IsNullOrEmpty($text)) {
              $results += @{
                Name = $current.Current.Name
                Value = $text
                ControlType = $current.Current.ControlType.ProgrammaticName
                BoundingRect = @{
                  X = $bounds.X
                  Y = $bounds.Y
                  Width = $bounds.Width
                  Height = $bounds.Height
                }
              }
            }
          }

          # Recurse into children
          $results += Get-TextFromElement $current ($depth + 1)
        } catch {}

        $current = $walker.GetNextSibling($current)
      }

      return $results
    }

    # Get element at center of rect first
    $centerX = ${safeX} + ${safeW} / 2
    $centerY = ${safeY} + ${safeH} / 2
    $centerPoint = New-Object System.Windows.Point($centerX, $centerY)
    $centerElement = [System.Windows.Automation.AutomationElement]::FromPoint($centerPoint)

    if ($centerElement -ne $null) {
      # Walk up to find a good starting point
      $parent = $centerElement
      for ($i = 0; $i -lt 5; $i++) {
        $p = $walker.GetParent($parent)
        if ($p -eq $null -or $p.Equals($root)) { break }
        $parent = $p
      }

      $allResults = Get-TextFromElement $parent 0

      # Also add the center element's text
      $text = ""
      try {
        $valuePattern = $centerElement.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($valuePattern -ne $null) { $text = $valuePattern.Current.Value }
      } catch {}

      if ([string]::IsNullOrEmpty($text)) {
        try {
          $textPattern = $centerElement.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
          if ($textPattern -ne $null) { $text = $textPattern.DocumentRange.GetText(1000) }
        } catch {}
      }

      if ([string]::IsNullOrEmpty($text)) { $text = $centerElement.Current.Name }

      if (-not [string]::IsNullOrEmpty($text)) {
        $bounds = $centerElement.Current.BoundingRectangle
        $allResults = @(@{
          Name = $centerElement.Current.Name
          Value = $text
          ControlType = $centerElement.Current.ControlType.ProgrammaticName
          BoundingRect = @{
            X = $bounds.X
            Y = $bounds.Y
            Width = $bounds.Width
            Height = $bounds.Height
          }
        }) + $allResults
      }
    }

    # Remove duplicates and output
    $unique = $allResults | Sort-Object { $_.BoundingRect.Y, $_.BoundingRect.X } -Unique
    ConvertTo-Json @{ Elements = $unique } -Depth 4
  `;

  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
      { timeout: 10000 }
    );

    const data = JSON.parse(stdout.trim());
    const elements = (data.Elements || []).map((e) => ({
      name: e.Name || "",
      value: e.Value || "",
      controlType: e.ControlType || "",
      boundingRect: {
        x: e.BoundingRect?.X || 0,
        y: e.BoundingRect?.Y || 0,
        width: e.BoundingRect?.Width || 0,
        height: e.BoundingRect?.Height || 0,
      },
    }));

    // Combine all text from elements
    const text = elements
      .map((e) => e.value || e.name)
      .filter((t) => t && t.trim())
      .join("\n");

    return {
      text: text.trim(),
      elements,
      success: elements.length > 0,
    };
  } catch (error) {
    return {
      text: "",
      elements: [],
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

module.exports = { getTextFromRect };
