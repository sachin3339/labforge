param([Parameter(Mandatory = $true)][string]$Token)

Add-Type -AssemblyName System.Web
$redeem = "https://api.environments.learnlytica.com/launch/redeem?t=$Token"
$loc = (curl.exe -s -o NUL -w "%{redirect_url}" $redeem)
if (-not $loc) { Write-Host "no redirect"; exit 1 }

$beforeHash = $loc.Split('#')[0]
$frag = $loc.Split('#')[1]
$qs = $beforeHash.Split('?')[1]
$q = [System.Web.HttpUtility]::ParseQueryString($qs)
$user = $q['username']
$pass = $q['password']
$cidB64 = $frag.Replace('/client/', '')
$cidBytes = [Convert]::FromBase64String($cidB64)
$cidStr = ([System.Text.Encoding]::UTF8.GetString($cidBytes))
$cidNum = $cidStr.Split([char]0)[0]
Write-Host "user=$user  pwlen=$($pass.Length)  cidNum=$cidNum"

$base = $beforeHash.Split('?')[0].TrimEnd('/')   # .../guacamole/
$tokUrl = "$base/api/tokens"
$body = "username=$([uri]::EscapeDataString($user))&password=$([uri]::EscapeDataString($pass))"
try {
  $tok = Invoke-RestMethod -Uri $tokUrl -Method Post -Body $body -ContentType 'application/x-www-form-urlencoded'
} catch {
  Write-Host "AUTH FAILED: $($_.Exception.Message)"
  exit 2
}
Write-Host "authToken len=$($tok.authToken.Length)  dataSource=$($tok.dataSource)  availableDS=$($tok.availableDataSources -join ',')"

$ds = $tok.dataSource
$connUrl = "$base/api/session/data/$ds/connections?token=$([uri]::EscapeDataString($tok.authToken))"
try {
  $conns = Invoke-RestMethod -Uri $connUrl -Method Get
} catch {
  Write-Host "CONN LIST FAILED: $($_.Exception.Message)"
  exit 3
}
$ids = $conns.PSObject.Properties.Name
Write-Host "visible connection ids for this user: $($ids -join ', ')"
if ($ids -contains $cidNum) {
  Write-Host "RESULT: PASS - URL cid=$cidNum is visible to the authenticated user"
} else {
  Write-Host "RESULT: FAIL - URL cid=$cidNum NOT in visible set -> 'connection does not exist'"
}
