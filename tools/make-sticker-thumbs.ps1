param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$generated = 0
$failed = 0
Get-ChildItem -Path $SourceDir -Recurse -File -Include *.jpg, *.jpeg, *.png, *.gif | ForEach-Object {
  $out = Join-Path $OutDir ($_.BaseName + ".png")
  if (Test-Path $out) { return }
  try {
    $img = [System.Drawing.Image]::FromFile($_.FullName)
    $scale = [Math]::Min(1.0, 120.0 / [Math]::Max($img.Width, $img.Height))
    $w = [Math]::Max(1, [int]($img.Width * $scale))
    $h = [Math]::Max(1, [int]($img.Height * $scale))
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $img.Dispose()
    $script:generated++
  } catch {
    $script:failed++
  }
}
Write-Output "stickers thumbs: $generated generated, $failed failed"
