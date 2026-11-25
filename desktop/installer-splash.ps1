param(
  [string]$InstDir = '',
  [string]$ExtractedFile = '',
  [string]$SignalFile = ''
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

function U([string]$b64) {
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

$msgUnbox   = U '5q2j5Zyo5ouG566x5a6J6KOFIFN1bW1vbiBCb3TigKY='
$msgUpgrade = U '5q2j5Zyo5Y2H57qnIFN1bW1vbiBCb3TigKY='
$msgWrite   = U '5q2j5Zyo6Kej5Y6L5bm25YaZ5YWl56iL5bqP5paH5Lu24oCm'
$msgFinish  = U '5q2j5Zyo5qCh6aqM5bm25pS25bC+5a6J6KOF5paH5Lu24oCm'
$msgWake    = U '56iL5bqP5bey5bCx5L2N77yM5q2j5Zyo5ZSk6YaSIFN1bW1vbiBCb3TigKY='
$isUpgrade  = [bool]($InstDir -and (Test-Path -LiteralPath (Join-Path $InstDir 'Summon Bot.exe')))

# Match Summon Bot's warm cotton-paper palette (or deep dark mode if Windows AppsUseLightTheme == 0)
$isDark = $false
try {
  $val = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction SilentlyContinue
  if ($val -eq 0) { $isDark = $true }
} catch {}

$cardBg     = if ($isDark) { '#151822' } else { '#FBF9F4' }
$cardBorder = if ($isDark) { '#2A3040' } else { '#E5E0D5' }
$inkColor   = if ($isDark) { '#F3F4F8' } else { '#1F1E1B' }
$mutedColor = if ($isDark) { '#A9B1C2' } else { '#6B665C' }
$trackBg    = if ($isDark) { '#252B3B' } else { '#ECE7DC' }
$fillBg     = if ($isDark) { '#E8EBF2' } else { '#262420' }
$shadowCol  = if ($isDark) { '#44000000' } else { '#221F1E1B' }

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Summon Bot"
        Width="540" Height="390"
        WindowStartupLocation="CenterScreen"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        ResizeMode="NoResize"
        Topmost="True"
        ShowInTaskbar="True">
  <Grid Margin="20">
    <Border Background="$cardBg" BorderBrush="$cardBorder" BorderThickness="1" CornerRadius="28">
      <Border.Effect>
        <DropShadowEffect Color="#000000" BlurRadius="32" ShadowDepth="10" Opacity="0.18"/>
      </Border.Effect>
      <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center" Width="400">
        <!-- Bouncing Paper-Craft Cardboard Box -->
        <Grid Width="136" Height="126" HorizontalAlignment="Center" Margin="0,0,0,10">
          <!-- Ground Shadow -->
          <Ellipse x:Name="BoxShadow" Width="82" Height="16" Fill="$shadowCol" VerticalAlignment="Bottom" Margin="0,0,0,6" RenderTransformOrigin="0.5,0.5">
            <Ellipse.RenderTransform>
              <ScaleTransform x:Name="ShadowScale" ScaleX="1" ScaleY="1"/>
            </Ellipse.RenderTransform>
          </Ellipse>
          <!-- Cardboard Box Vector (Paper-Craft Style) -->
          <Canvas x:Name="BoxCanvas" Width="116" Height="106" HorizontalAlignment="Center" VerticalAlignment="Center" RenderTransformOrigin="0.5,0.85">
            <Canvas.RenderTransform>
              <TransformGroup>
                <ScaleTransform x:Name="BoxScale" ScaleX="1" ScaleY="1"/>
                <RotateTransform x:Name="BoxRotate" Angle="0"/>
                <TranslateTransform x:Name="BoxTranslate" X="0" Y="0"/>
              </TransformGroup>
            </Canvas.RenderTransform>
            <!-- Top inner lip -->
            <Polygon Points="22,34 58,18 94,34 58,50" Fill="#B88E5F"/>
            <!-- Left top flap -->
            <Polygon Points="22,34 58,18 52,12 16,28" Fill="#DFC19A" Stroke="#B99265" StrokeThickness="1"/>
            <!-- Right top flap -->
            <Polygon Points="94,34 58,18 64,12 100,28" Fill="#E7CCA7" Stroke="#B99265" StrokeThickness="1"/>
            <!-- Front-left face -->
            <Polygon Points="22,34 58,50 58,92 22,76" Fill="#D5B184" Stroke="#B99265" StrokeThickness="1"/>
            <!-- Front-right face -->
            <Polygon Points="58,50 94,34 94,76 58,92" Fill="#C59C6D" Stroke="#A88052" StrokeThickness="1"/>
            <!-- Paper tape strip on top seam -->
            <Polygon Points="49,22 67,30 63,34 45,26" Fill="#F3E5CE" Opacity="0.88"/>
            <!-- Cute subtle paper label badge on right face -->
            <Polygon Points="68,54 85,46 85,57 68,65" Fill="#FBF7EE" Opacity="0.9"/>
            <!-- Little dark lines on label -->
            <Line X1="71" Y1="57" X2="82" Y2="52" Stroke="#9D8C75" StrokeThickness="1.6"/>
            <Line X1="71" Y1="61" X2="79" Y2="57" Stroke="#B9AA96" StrokeThickness="1.3"/>
          </Canvas>
        </Grid>

        <TextBlock Text="Summon Bot" Height="28" FontFamily="Segoe UI, Microsoft YaHei UI" FontSize="23" FontWeight="Bold" Foreground="$inkColor" HorizontalAlignment="Center" Margin="0,0,0,8"/>
        <TextBlock x:Name="StatusText" Height="21" Text="" FontFamily="Segoe UI, Microsoft YaHei UI" FontSize="13.5" Foreground="$mutedColor" HorizontalAlignment="Center" Margin="0,0,0,18"/>

        <!-- Clean Unified Progress Bar -->
        <Border Width="340" Height="7" CornerRadius="3.5" Background="$trackBg" HorizontalAlignment="Center" ClipToBounds="True">
          <Border x:Name="ProgressFill" Width="28" Height="7" CornerRadius="3.5" Background="$fillBg" HorizontalAlignment="Left"/>
        </Border>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win = [Windows.Markup.XamlReader]::Load($reader)

$boxTranslate = $win.FindName('BoxTranslate')
$boxScale     = $win.FindName('BoxScale')
$boxRotate    = $win.FindName('BoxRotate')
$shadowScale  = $win.FindName('ShadowScale')
$statusText   = $win.FindName('StatusText')
$progressFill = $win.FindName('ProgressFill')
$statusText.Text = if ($isUpgrade) { $msgUpgrade } else { $msgUnbox }

# Direct BeginAnimation on WPF Transform DependencyProperties (100% reliable, starts hopping immediately!)
function New-LoopKFAnim([double]$durSec, [object[]]$pairs) {
  $anim = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $anim.Duration = [System.TimeSpan]::FromSeconds($durSec)
  $anim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  foreach ($p in $pairs) {
    $kf = New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame
    $kf.KeyTime = [System.Windows.Media.Animation.KeyTime]::FromTimeSpan([System.TimeSpan]::FromSeconds([double]$p[0]))
    $kf.Value = [double]$p[1]
    [void]$anim.KeyFrames.Add($kf)
  }
  return $anim
}

$animY = New-LoopKFAnim 1.7 @(
  @(0.00, 0), @(0.22, 0), @(0.34, 4.5), @(0.52, -16), @(0.68, 0), @(0.79, -5.5), @(0.90, 0), @(1.70, 0)
)
$animSX = New-LoopKFAnim 1.7 @(
  @(0.00, 1), @(0.22, 1), @(0.34, 1.09), @(0.52, 0.93), @(0.68, 1.04), @(0.84, 1), @(1.70, 1)
)
$animSY = New-LoopKFAnim 1.7 @(
  @(0.00, 1), @(0.22, 1), @(0.34, 0.90), @(0.52, 1.08), @(0.68, 0.96), @(0.84, 1), @(1.70, 1)
)
$animRot = New-LoopKFAnim 1.7 @(
  @(0.00, 0), @(0.30, 0), @(0.46, -3.5), @(0.62, 2.8), @(0.76, -1.2), @(0.88, 0), @(1.70, 0)
)
$animSh = New-LoopKFAnim 1.7 @(
  @(0.00, 1), @(0.22, 1), @(0.34, 1.09), @(0.52, 0.74), @(0.68, 1.03), @(0.86, 1), @(1.70, 1)
)

$win.Add_Loaded({
  $boxTranslate.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $animY)
  $boxScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $animSX)
  $boxScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $animSY)
  $boxRotate.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $animRot)
  $shadowScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $animSh)
})

# Progress polling + seamless handoff to Summon Bot.exe
$script:pct = 8.0
$script:startedAt = Get-Date
$script:lastActivity = Get-Date
$script:tickCount = 0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [System.TimeSpan]::FromMilliseconds(80)
$timer.Add_Tick({
  if ($SignalFile -and (Test-Path -LiteralPath $SignalFile)) {
    $timer.Stop()
    $win.Close()
    return
  }
  $script:tickCount++
  $elapsed = ((Get-Date) - $script:startedAt).TotalSeconds
  $extracted = [bool]($ExtractedFile -and (Test-Path -LiteralPath $ExtractedFile))
  if ($extracted) {
    $script:pct = [math]::Min(54.0, [math]::Max($script:pct + 1.4, 50.0))
    $statusText.Text = $msgWake
  } else {
    # Asymptotic creep 8% -> 48% so upgrade/overwrite installs never jump prematurely to 54% or look frozen
    $target = 8.0 + 40.0 * (1.0 - [math]::Exp(-$elapsed / 14.0))
    $script:pct = [math]::Min(48.0, [math]::Max($script:pct, $target))
    if ($elapsed -lt 3.5) {
      $statusText.Text = if ($isUpgrade) { $msgUpgrade } else { $msgUnbox }
    } elseif ($elapsed -lt 14.0) {
      $statusText.Text = $msgWrite
    } else {
      $statusText.Text = $msgFinish
    }
  }
  $progressFill.Width = [math]::Round(340.0 * ($script:pct / 100.0))

  if ($script:tickCount % 20 -eq 0) {
    $alive = [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'Summon-Bot|Summon Bot|Uninstall Summon|old-uninstaller|^Au_|^Un_' } | Select-Object -First 1)
    if ($alive) { $script:lastActivity = Get-Date }
    $sinceEnd = ((Get-Date) - $script:lastActivity).TotalSeconds
    if ($elapsed -gt 180 -or (-not $alive -and $sinceEnd -gt 25)) {
      $timer.Stop()
      $win.Close()
    }
  }
})
$timer.Start()

[void]$win.ShowDialog()
