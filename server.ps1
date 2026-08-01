param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Rooms = @{}
$Mime = @{'.html'='text/html; charset=utf-8';'.js'='application/javascript; charset=utf-8';'.css'='text/css; charset=utf-8';'.json'='application/json; charset=utf-8';'.png'='image/png';'.jpg'='image/jpeg';'.svg'='image/svg+xml';'.ico'='image/x-icon'}
function NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function NewRoom([string]$Code) {
  return [ordered]@{ code=$Code; mode='group'; title='Yamyam Marble Pinball'; map='wheel'; status='lobby'; participants=@(); winMode='first'; winningRanks=@(1); finishOrder=@(); winners=@(); snapshot=[ordered]@{balls=@();rot=@();gate=0;cam=0;camX=560;camZoom=0.82}; raceId=0; seed=1; shuffleNonce=0; winnerDeclared=$false; startedAt=0; duration=0; updatedAt=(NowMs) }
}
function GetRoom([string]$Code) {
  if ([string]::IsNullOrWhiteSpace($Code)) { $Code='YAMYAM' }
  $Code=($Code -replace '[^A-Za-z0-9_-]','').ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($Code)) { $Code='YAMYAM' }
  if (-not $Rooms.ContainsKey($Code)) { $Rooms[$Code]=NewRoom $Code }
  return $Rooms[$Code]
}
function Touch($Room) { $Room.updatedAt=NowMs }
function BackToLobby($Room) { $Room.status='lobby';$Room.finishOrder=@();$Room.winners=@();$Room.winnerDeclared=$false;$Room.snapshot=[ordered]@{balls=@();rot=@();gate=0;cam=0;camX=560;camZoom=0.82};$Room.startedAt=0;$Room.duration=0 }
function SendBytes($Ctx,[int]$Status,[byte[]]$Bytes,[string]$Type) {
  $Ctx.Response.StatusCode=$Status; $Ctx.Response.ContentType=$Type; $Ctx.Response.ContentLength64=$Bytes.Length
  $Ctx.Response.Headers['Cache-Control']='no-store, no-cache, must-revalidate'
  $Ctx.Response.OutputStream.Write($Bytes,0,$Bytes.Length); $Ctx.Response.OutputStream.Close()
}
function SendText($Ctx,[int]$Status,[string]$Text,[string]$Type) { SendBytes $Ctx $Status ([Text.Encoding]::UTF8.GetBytes($Text)) $Type }
function SendJson($Ctx,[int]$Status,$Obj) { SendText $Ctx $Status ($Obj|ConvertTo-Json -Depth 30 -Compress) 'application/json; charset=utf-8' }
function ReadJson($Req) { $r=New-Object IO.StreamReader($Req.InputStream,[Text.Encoding]::UTF8); try{$b=$r.ReadToEnd()}finally{$r.Dispose()}; if([string]::IsNullOrWhiteSpace($b)){return $null}; return $b|ConvertFrom-Json }
function Shuffle($Items) { $a=New-Object Collections.ArrayList; foreach($x in $Items){[void]$a.Add($x)}; for($i=$a.Count-1;$i -gt 0;$i--){$j=Get-Random -Minimum 0 -Maximum ($i+1);$t=$a[$i];$a[$i]=$a[$j];$a[$j]=$t}; return @($a) }
function HandleAction($Ctx,$D) {
  $R=GetRoom ([string]$D.room); $A=[string]$D.action; $MinimalResponse=$false
  switch($A) {
    'addParticipant' {
      if($R.status -eq 'running'){throw 'Race is running.'}
      $Name=([string]$D.name).Trim(); if($Name.Length -lt 1 -or $Name.Length -gt 24){throw 'Name must be 1-24 characters.'}
      $Owner=([string]$D.owner).Trim(); if($Owner.Length -gt 40){throw 'Owner name is too long.'}
      $Count=[long]$D.count; if($Count -lt 1){$Count=1}
      $R.participants += [ordered]@{id=[Guid]::NewGuid().ToString('N');name=$Name;owner=$Owner;count=$Count;addedAt=(NowMs)}; BackToLobby $R; Touch $R
    }
    'bulkAdd' {
      if($R.status -eq 'running'){throw 'Race is running.'}
      $Owner=([string]$D.owner).Trim(); foreach($it in @($D.items)){$Name=([string]$it.name).Trim();$Count=[long]$it.count;if($Count -lt 1){$Count=1};if($Name.Length -ge 1 -and $Name.Length -le 24){$R.participants += [ordered]@{id=[Guid]::NewGuid().ToString('N');name=$Name;owner=$Owner;count=$Count;addedAt=(NowMs)}}}; BackToLobby $R; Touch $R
    }
    'removeParticipant' { if($R.status -eq 'running'){throw 'Race is running.'};$Id=[string]$D.id;$Owner=[string]$D.owner;$Admin=[bool]$D.admin;$R.participants=@($R.participants|Where-Object{-not($_.id -eq $Id -and ($Admin -or $_.owner -eq $Owner))});BackToLobby $R;Touch $R }
    'removeParticipants' { if($R.status -eq 'running'){throw 'Race is running.'};$Ids=@($D.ids|ForEach-Object{[string]$_});$Owner=[string]$D.owner;$Admin=[bool]$D.admin;$R.participants=@($R.participants|Where-Object{-not(($Ids -contains [string]$_.id) -and ($Admin -or $_.owner -eq $Owner))});BackToLobby $R;Touch $R }
    'adjustParticipantGroup' {
      if($R.status -eq 'running'){throw 'Race is running.'}
      $Ids=@($D.ids|ForEach-Object{[string]$_});$Owner=[string]$D.owner;$Admin=[bool]$D.admin
      $Matches=@($R.participants|Where-Object{($Ids -contains [string]$_.id) -and ($Admin -or $_.owner -eq $Owner)})
      if($Matches.Count -eq 0){throw 'Participant not found.'}
      $Current=0;foreach($P in $Matches){$Current += [long]$P.count}
      if($null -ne $D.count){$Target=[long]$D.count}else{$Target=$Current+[long]$D.delta}
      if($Target -lt 0){$Target=0};if($Target -gt 5000){$Target=5000}
      $KeepId=[string]$Matches[0].id
      if($Target -eq 0){$R.participants=@($R.participants|Where-Object{-not(($Ids -contains [string]$_.id) -and ($Admin -or $_.owner -eq $Owner))})}
      else{
        foreach($P in $R.participants){if([string]$P.id -eq $KeepId){$P.count=$Target}}
        $R.participants=@($R.participants|Where-Object{([string]$_.id -eq $KeepId) -or -not(($Ids -contains [string]$_.id) -and ($Admin -or $_.owner -eq $Owner))})
      }
      BackToLobby $R;Touch $R
    }
    'setMode' { $M=[string]$D.mode;if($M -ne 'solo' -and $M -ne 'group'){throw 'Invalid mode.'};$R.mode=$M;Touch $R }
    'setTitle' { $T=([string]$D.title).Trim();if($T.Length -gt 50){$T=$T.Substring(0,50)};$R.title=$T;Touch $R }
    'setMap' { $M=[string]$D.map;if(@('wheel','cascade','maze') -notcontains $M){throw 'Invalid map.'};$R.map=$M;$R.status='lobby';$R.raceBalls=@();$R.finishOrder=@();$R.winners=@();$R.winnerDeclared=$false;$R.snapshot=[ordered]@{balls=@();rot=@();gate=0;cam=0;camX=560;camZoom=0.82};$R.startedAt=0;$R.duration=0;$R.shuffleNonce=[int]$R.shuffleNonce+1;$R.seed=Get-Random -Minimum 100000 -Maximum 2147483000;Touch $R }
    'setWin' { $Mode=([string]$D.winMode).ToLowerInvariant();if(@('first','last','number') -notcontains $Mode){throw 'Invalid winner mode.'};$v=@();foreach($x in @($D.ranks)){$n=0;if([int]::TryParse([string]$x,[ref]$n) -and $n -gt 0){$v+=$n}};if($Mode -eq 'number' -and $v.Count -eq 0){throw 'Please enter a valid rank.'};$R.winMode=$Mode;$R.winningRanks=if($Mode -eq 'number'){@($v|Sort-Object -Unique)}else{@(1)};Touch $R;$MinimalResponse=$true }
    'shuffle' { if($R.status -eq 'running'){throw 'Race is running.'}; BackToLobby $R; $R.shuffleNonce=[int]$R.shuffleNonce+1; $R.seed=Get-Random -Minimum 100000 -Maximum 2147483000; Touch $R }
    'startRace' {
      # 시작 요청 하나에서 맵과 당첨 기준을 함께 확정한다.
      $StartMap=[string]$D.map
      if(@('wheel','cascade','maze') -contains $StartMap){$R.map=$StartMap}
      # 시작 요청에 당첨 기준을 함께 실어 보내므로, 별도 저장 요청이 지연돼도 레이스에는 즉시 정확히 적용된다.
      $StartMode=([string]$D.winMode).ToLowerInvariant()
      if(@('first','last','number') -contains $StartMode){
        $StartRanks=@();foreach($x in @($D.ranks)){$n=0;if([int]::TryParse([string]$x,[ref]$n) -and $n -gt 0){$StartRanks+=$n}}
        if($StartMode -ne 'number' -or $StartRanks.Count -gt 0){$R.winMode=$StartMode;$R.winningRanks=if($StartMode -eq 'number'){@($StartRanks|Sort-Object -Unique)}else{@(1)}}
      }
      $balls=@();foreach($p in $R.participants){for($i=1;$i -le [long]$p.count;$i++){$balls += [ordered]@{ballId=($p.id+'_'+$i);participantId=$p.id;name=$p.name;owner=$p.owner;copy=$i}}}
      if($balls.Count -lt 1){throw 'At least 1 ball is required.'}
      $R.raceBalls=@($balls);$R.finishOrder=@();$R.winners=@();$R.winnerDeclared=$false;$R.snapshot=[ordered]@{balls=@();rot=@();gate=0;cam=0;camX=560;camZoom=0.82}
      $R.raceId=[int]$R.raceId+1;if([int]$R.seed -le 0){$R.seed=Get-Random -Minimum 100000 -Maximum 2147483000};$R.startedAt=(NowMs)+250;$R.duration=0;$R.status='running';Touch $R
      SendJson $Ctx 200 ([ordered]@{ok=$true;raceId=$R.raceId;seed=$R.seed;status=$R.status;map=$R.map;winMode=$R.winMode;winningRanks=@($R.winningRanks)});return
    }
    'snapshot' { if($R.status -eq 'running'){$R.snapshot=[ordered]@{balls=@($D.balls);rot=@($D.rot);gate=[double]$D.gate;cam=[double]$D.cam;camX=[double]$D.camX;camZoom=[double]$D.camZoom};Touch $R} }
    'finishBall' {
      if($R.status -eq 'running'){
        $Id=[string]$D.ballId
        if(-not(@($R.finishOrder|Where-Object{$_.ballId -eq $Id}).Count)){
          $B=@($R.raceBalls|Where-Object{$_.ballId -eq $Id})[0]
          if($null -ne $B){$Rank=$R.finishOrder.Count+1;$Item=[ordered]@{ballId=$B.ballId;name=$B.name;copy=$B.copy;owner=$B.owner;rank=$Rank};$R.finishOrder += $Item}
        }
        if(-not [bool]$R.winnerDeclared){
          $Ready=$false
          if($R.winMode -eq 'first' -and $R.finishOrder.Count -ge 1){$Ready=$true}
          elseif($R.winMode -eq 'number'){$Target=($R.winningRanks|Measure-Object -Maximum).Maximum;if($R.finishOrder.Count -ge $Target){$Ready=$true}}
          elseif($R.winMode -eq 'last' -and $R.finishOrder.Count -ge @($R.raceBalls).Count){$Ready=$true}
          if($Ready){
            $R.winners=@()
            if($R.winMode -eq 'first'){$R.winners += $R.finishOrder[0]}
            elseif($R.winMode -eq 'last'){$R.winners += $R.finishOrder[-1]}
            else{foreach($rk in $R.winningRanks){if($rk -le $R.finishOrder.Count){$R.winners += $R.finishOrder[$rk-1]}}}
            $R.winnerDeclared=$true
          }
        }
        Touch $R
      }
    }
    'completeRace' { if($R.status -eq 'running'){$R.status='completed';Touch $R} }
    'resetRace' {
      # 방·연결·참가자는 유지하고 현재 경기 공/순위/스냅샷만 비운다.
      $R.status='lobby';$R.finishOrder=@();$R.winners=@();$R.winnerDeclared=$false;$R.raceBalls=@();
      $R.snapshot=[ordered]@{balls=@();rot=@();gate=0;cam=0;camX=560;camZoom=0.82};$R.startedAt=0;$R.duration=0
      $R.shuffleNonce=[int]$R.shuffleNonce+1;$R.seed=Get-Random -Minimum 100000 -Maximum 2147483000
      Touch $R
    }
    'clearParticipants' {$R.status='lobby';$R.participants=@();$R.raceBalls=@();$R.finishOrder=@();$R.winners=@();$R.winnerDeclared=$false;$R.snapshot=[ordered]@{balls=@();rot=@();gate=0;cam=0;camX=560;camZoom=0.82};$R.startedAt=0;$R.duration=0;$R.shuffleNonce=[int]$R.shuffleNonce+1;$R.seed=Get-Random -Minimum 100000 -Maximum 2147483000;Touch $R}
    default {throw 'Unknown action.'}
  }
  if($MinimalResponse){SendJson $Ctx 200 ([ordered]@{ok=$true;winMode=$R.winMode;winningRanks=@($R.winningRanks);updatedAt=$R.updatedAt})}else{SendJson $Ctx 200 ([ordered]@{ok=$true;state=$R})}
}
$L=New-Object Net.HttpListener
$L.Prefixes.Add("http://localhost:$Port/");$L.Prefixes.Add("http://127.0.0.1:$Port/")
try{$L.Start()}catch{Write-Host '';Write-Host 'SERVER START FAILED' -ForegroundColor Red;Write-Host $_.Exception.Message -ForegroundColor Red;Read-Host 'Press Enter';exit 1}
Write-Host '';Write-Host 'YAMYAM MARBLE PINBALL SERVER' -ForegroundColor Cyan
Write-Host "Admin   http://localhost:$Port/admin.html?room=YAMYAM";Write-Host "Member  http://localhost:$Port/member.html?room=YAMYAM";Write-Host "Overlay http://localhost:$Port/display.html?room=YAMYAM";Write-Host '';Write-Host 'Keep this window open.' -ForegroundColor Yellow
Start-Process "http://localhost:$Port/admin.html?room=YAMYAM"
while($L.IsListening){
  try{$C=$L.GetContext();$Q=$C.Request;$P=[Uri]::UnescapeDataString($Q.Url.AbsolutePath)
    if($P -eq '/api/state' -and $Q.HttpMethod -eq 'GET'){SendJson $C 200 ([ordered]@{ok=$true;state=(GetRoom $Q.QueryString['room'])});continue}
    if($P -eq '/api/action' -and $Q.HttpMethod -eq 'POST'){try{HandleAction $C (ReadJson $Q)}catch{SendJson $C 400 ([ordered]@{ok=$false;error=$_.Exception.Message})};continue}
    if($P -eq '/'){$P='/admin.html'};$Rel=$P.TrimStart('/') -replace '/', [IO.Path]::DirectorySeparatorChar;$Full=[IO.Path]::GetFullPath((Join-Path $Root $Rel));$Base=[IO.Path]::GetFullPath($Root)
    if(-not $Full.StartsWith($Base,[StringComparison]::OrdinalIgnoreCase)){SendText $C 403 'Forbidden' 'text/plain';continue}
    if(-not(Test-Path -LiteralPath $Full -PathType Leaf)){SendText $C 404 'Not found' 'text/plain';continue}
    $E=[IO.Path]::GetExtension($Full).ToLowerInvariant();$T='application/octet-stream';if($Mime.ContainsKey($E)){$T=$Mime[$E]};SendBytes $C 200 ([IO.File]::ReadAllBytes($Full)) $T
  }catch{try{SendText $C 500 'Server error' 'text/plain'}catch{}}
}
