# Engangsskript: fyller ut kommune (og bydel der den finnes) for funn som ble registrert før
# supabase/sql/statistikk-etter-ett-aar.sql. Etter ett år slettes lat/lng og stedsnavn,
# så dette må kjøres før det, ellers mister vi stedet for de gamle funnene.
#
# Kilde: kartposisjonen (lat/lng) slås opp i OpenStreetMap/Nominatim, samme gratis tjeneste som appen bruker.
# Funn uten lat/lng får ikke kommune herfra. Søk på stedsnavn-teksten ble testet og ga for mange feil
# (f.eks. «Ullern skole» -> Sør-Odal), så den brukes ikke. Slike funn kan fylles ut for hånd i Table Editor.
#
# Rekkefølge: kjør SQL-en først, så dette skriptet, og publiser glemmekassen-sms etterpå.
#
# Slik kjøres det (Windows PowerShell, fra repo-mappen):
#   $env:APP_SERVICE_KEY = '<service_role-nøkkelen fra Supabase: Project Settings -> API>'
#   .\supabase\scripts\fyll-kommune-for-gamle-funn.ps1           # prøvekjøring: viser hva som ville blitt lagret
#   .\supabase\scripts\fyll-kommune-for-gamle-funn.ps1 -Lagre    # lagrer
#   Remove-Item Env:APP_SERVICE_KEY                              # fjern nøkkelen etterpå
# Nøkkelen skal aldri skrives inn i denne filen.
# Kan kjøres flere ganger: tar bare funn som mangler kommune, har lat/lng og ikke er tømt.

param(
  [switch]$Lagre   # uten denne endres ingenting i databasen
)
$ErrorActionPreference = 'Stop'

$SupabaseUrl = 'https://jyajkriknplrhsxustpf.supabase.co'
$Tabell = 'glemmekassen_shortlink_test'
# Nominatim krever et navn på den som spør, og maks ett oppslag per sekund
$UserAgent = 'Glemmekassen-engangsfylling/1.0 (glemmekassen.com)'

# Samme regel som settOmraade() i hittegods.html
function Hent-Omraade($a) {
  if (-not $a) { return $null }
  $kommune = @($a.municipality, $a.city, $a.town, $a.village) | Where-Object { $_ } | Select-Object -First 1
  if (-not $kommune) { return $null }
  # Bare ekte bydel (city_district). «suburb» er strøk (f.eks. Vika), ikke bydel, og lagres ikke.
  $k = [string]$kommune; $b = [string]$a.city_district
  return @{ kommune = $k.Substring(0, [Math]::Min(40, $k.Length)); bydel = $(if ($b) { $b.Substring(0, [Math]::Min(40, $b.Length)) } else { $null }) }
}

function Fra-Posisjon($lat, $lng) {
  $la = ([double]$lat).ToString([Globalization.CultureInfo]::InvariantCulture)
  $lo = ([double]$lng).ToString([Globalization.CultureInfo]::InvariantCulture)
  $svar = Invoke-RestMethod -UserAgent $UserAgent -Uri "https://nominatim.openstreetmap.org/reverse?lat=$la&lon=$lo&format=json&accept-language=nb"
  return Hent-Omraade $svar.address
}

# Stopper her når filen bare lastes inn for testing (. .\fyll-kommune-for-gamle-funn.ps1)
if ($MyInvocation.InvocationName -eq '.') { return }

$key = $env:APP_SERVICE_KEY
if (-not $key) { throw 'Sett $env:APP_SERVICE_KEY først (se toppen av filen).' }
$h = @{ apikey = $key; Authorization = "Bearer $key" }

# Hvor mange funn mangler kommune og har ikke lat/lng (kan ikke fylles ut av skriptet)
$uten = Invoke-WebRequest -UseBasicParsing -Method Head -Headers ($h + @{ Prefer = 'count=exact' }) `
  -Uri "$SupabaseUrl/rest/v1/${Tabell}?select=id&kommune=is.null&anonymisert_at=is.null&or=(lat.is.null,lng.is.null)"
$antallUten = ([string]$uten.Headers['Content-Range']).Split('/')[-1]

# Windows PowerShell gir lister som ett objekt – pakkes ut med ForEach-Object
$svar = Invoke-RestMethod -Headers $h -Uri "$SupabaseUrl/rest/v1/${Tabell}?select=id,lat,lng&kommune=is.null&anonymisert_at=is.null&lat=not.is.null&lng=not.is.null&order=created_at.asc&limit=2000"
$rader = @($svar | ForEach-Object { $_ })
Write-Host "Funn med kartposisjon som mangler kommune: $($rader.Count)"
Write-Host "Funn uten kartposisjon (fylles ikke ut her): $antallUten"

$funnet = 0; $ikke = 0
foreach ($r in $rader) {
  $o = $null
  try { $o = Fra-Posisjon $r.lat $r.lng }
  catch { Write-Host "  $($r.id.Substring(0,8)): oppslaget feilet ($($_.Exception.Message))"; Start-Sleep -Seconds 5 }
  Start-Sleep -Milliseconds 1100
  if ($o) { $funnet++ } else { $ikke++ }
  # Skriver bare id-start, kommune og bydel – aldri stedsnavn eller posisjon
  Write-Host ("  {0}: {1} / {2}" -f $r.id.Substring(0, 8), $(if ($o) { $o.kommune } else { '-' }), $(if ($o -and $o.bydel) { $o.bydel } else { '-' }))
  if ($o -and $Lagre) {
    $json = @{ kommune = $o.kommune; bydel = $o.bydel } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json; charset=utf-8' `
      -Uri "$SupabaseUrl/rest/v1/${Tabell}?id=eq.$($r.id)" -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
  }
}
Write-Host "Fikk kommune: $funnet  Fant ingen kommune: $ikke"
if (-not $Lagre) { Write-Host 'Prøvekjøring – ingenting er lagret. Kjør med -Lagre for å lagre.' }
