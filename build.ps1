# Genere builds/weelspin.html : un fichier HTML unique, CSS/JS/favicon inclus.
# Produit aussi weelspin-dist.zip (contenu de src/) pour un deploiement classique.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'src'
$out = Join-Path $root 'builds'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

$html = Get-Content (Join-Path $src 'index.html') -Raw -Encoding UTF8
$css = Get-Content (Join-Path $src 'styles.css') -Raw -Encoding UTF8
$js = Get-Content (Join-Path $src 'app.js') -Raw -Encoding UTF8
$svg = Get-Content (Join-Path $src 'favicon.svg') -Raw -Encoding UTF8

# Une balise fermante dans le CSS ou le JS couperait le document : on refuse plutot
# que de produire un fichier silencieusement casse.
if ($css -match '</style') { throw "styles.css contient '</style' : inlining impossible." }
if ($js -match '</script') { throw "app.js contient '</script' : inlining impossible." }

$fav = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($svg))

$html = $html.Replace(
  '<link rel="icon" href="./favicon.svg" type="image/svg+xml">',
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,' + $fav + '">')
$html = $html.Replace(
  '<link rel="stylesheet" href="./styles.css">',
  "<style>`n" + $css + "`n</style>")
$html = $html.Replace(
  '<script src="./app.js"></script>',
  "<script>`n" + $js + "`n</script>")

foreach ($needle in @('./styles.css', './app.js', './favicon.svg')) {
  if ($html.Contains($needle)) { throw "Reference residuelle a $needle : le fichier ne serait pas autonome." }
}

$single = Join-Path $out 'weelspin.html'
[IO.File]::WriteAllText($single, $html, (New-Object Text.UTF8Encoding $false))

$zip = Join-Path $root 'weelspin-dist.zip'
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip -Force

$kb = [math]::Round((Get-Item $single).Length / 1KB)
Write-Output "OK : builds/weelspin.html ($kb Ko, autonome) et weelspin-dist.zip crees."
