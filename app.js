/* 얌얌랜드 공유핀볼 v15.10w 모든맵 공통 핀볼셋팅 기본화 - v14.3 검증 렌더러 기반 - 화면 확대·공 가독성 강화 */
'use strict';
const YamyamApp=(()=>{
const qs=new URLSearchParams(location.search),room=(qs.get('room')||'YAMYAM').replace(/[^A-Za-z0-9_-]/g,'').toUpperCase();
let role='display',unifiedMode=false,eventSource=null,state=null,owner='',sim=null,lastRace=-1,polling=false,lastRankCount=-1,lastWinnerRace=-1,pendingWinMode=null,mutationBusy=false,winDraft=null,winSaveTimer=0,winSaveInFlight=false,winSaveQueued=false,localRunning=false,localRaceConfig=null,manualCam=null,snapshotInFlight=false,connectionFailures=0,resetInFlight=false,lifecycleEpoch=0,pendingMap=null,selectedMapLock=null,serverStateSuppressedUntil=0,lastRenderErrorAt=0,remoteBallView=new Map(),lastRemoteFrameTs=0,nameHueMap=new Map(),nextNameHueIndex=0,nameColorSignature='',winnerPopupFirstSeenAt=0,mapChangeToken=0,canvasDragFastForward=false,suppressNextCanvasClick=false,raceHostId=null,snapshotSeq=0,lastAcceptedSnapshotSeq=0,remoteSnapshotReceivedAt=0,sharedPointer=null,interactionSeq=0;
const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const ADMIN_PREFS_KEY='yamyam_pinball_admin_prefs_'+room;
// 모든 맵이 공유하는 기본 핀볼 연출 설정. 맵을 바꾸거나 경기를 초기화해도 이 값은 사라지지 않는다.
const GLOBAL_PINBALL_EFFECTS=Object.freeze({
 winnerCloseupMs:700,
 winnerHideAfterCloseup:true,
 winnerPopupPersistent:true,
 winnerReturnToMain:true,
 cameraLeadTracking:true,
 cameraPointTour:true,
 cameraWinnerPrep:true,
 impactEnabled:true,
 rankLiveSync:true,
 manualScrollAfterFinish:true
});
function globalEffects(){return {...GLOBAL_PINBALL_EFFECTS}}
function loadAdminPrefs(){
 if(unifiedMode)return;
 try{
  const raw=JSON.parse(localStorage.getItem(ADMIN_PREFS_KEY)||'null');
  if(!raw||typeof raw!=='object')return;
  if(raw.map==='wheel'||raw.map==='greed')selectedMapLock=raw.map;
  const mode=['first','last','number'].includes(raw.winMode)?raw.winMode:null;
  const ranks=Array.isArray(raw.winningRanks)?raw.winningRanks.map(Number).filter(n=>Number.isInteger(n)&&n>0):[];
  if(mode)winDraft={mode,ranks:mode==='number'?(ranks.length?ranks:[1]):[1],dirty:false};
 }catch(e){console.warn('관리자 설정 복원 실패',e)}
}
function saveAdminPrefs(){
 if(role!=='admin'||unifiedMode)return;
 try{
  const mode=winDraft?.mode||state?.winMode||'first';
  const ranks=mode==='last'?[Math.max(1,balls().length)]:(winDraft?.ranks||state?.winningRanks||[1]);
  localStorage.setItem(ADMIN_PREFS_KEY,JSON.stringify({map:selectedMapLock||state?.map||'wheel',winMode:mode,winningRanks:ranks}));
 }catch(e){console.warn('관리자 설정 저장 실패',e)}
}
function applyAdminPrefs(target,map){
 if(!target||unifiedMode)return target;
 if(map)target.map=map;
 if(winDraft){target.winMode=winDraft.mode;target.winningRanks=winDraft.mode==='last'?[Math.max(1,(target.participants||[]).reduce((n,p)=>n+(Number(p.count)||0),0))]:[...winDraft.ranks]}
 return target;
}
// v14.2: 원본 roulette와 같은 box2d-wasm 7.0.0을 브라우저에서 직접 불러온다.
const box2dFactoryPromise=import('https://cdn.jsdelivr.net/npm/box2d-wasm@7.0.0/+esm').then(m=>m.default||m).catch(e=>{console.error('Box2D 로드 실패',e);return null});
async function api(action,data={}){const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,action,...data})});const j=await r.json();if(!j.ok)throw Error(j.error||'오류');state=j.state;if(role==='admin'&&!unifiedMode&&selectedMapLock&&state&&!localRunning)state.map=selectedMapLock;ui();return j}
async function apiQuiet(action,data={},timeoutMs=5000){const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),timeoutMs);try{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,action,...data}),signal:ctl.signal,cache:'no-store'});if(!r.ok){let msg='통신 오류';try{const e=await r.json();msg=e.error||msg}catch{}throw Error(msg)}return await r.json()}catch(e){if(e?.name==='AbortError')throw Error('서버 응답 시간 초과');throw e}finally{clearTimeout(tm)}}
function makeLobbyState(map,{clearParticipants=false}={}){
 const base=state||{};
 return{...base,map:map||base.map||'wheel',effectProfile:'global',status:'lobby',participants:clearParticipants?[]:(base.participants||[]),finishOrder:[],winners:[],winnerDeclared:false,raceBalls:[],snapshot:{balls:[],rot:[],gate:0,cam:0,camX:W/2,camZoom:.96}};
}
function restoreLobbyPreview(map,{clearParticipants=false}={}){
 stopLocalRace({clearParticipants});
 state=makeLobbyState(map,{clearParticipants});
 serverStateSuppressedUntil=performance.now()+3500;
 pendingMap=null;manualCam=null;
 ui();
}
function stopLocalRace({clearParticipants=false}={}){
 lifecycleEpoch++;
 if(sim)sim.paused=true;
 sim=null;localRunning=false;localRaceConfig=null;raceHostId=null,snapshotSeq=0,lastAcceptedSnapshotSeq=0,remoteSnapshotReceivedAt=0,sharedPointer=null,interactionSeq=0;lastRace=-1;lastWinnerRace=-1;winnerPopupFirstSeenAt=0;manualCam=null;
 snapshotInFlight=false;
 if(state){state.status='lobby';state.finishOrder=[];state.winners=[];state.winnerDeclared=false;state.snapshot={balls:[],rot:[],gate:0,cam:0,camX:560,camZoom:.96};state.raceBalls=[];if(clearParticipants)state.participants=[]}
 // 새 판/맵 변경 즉시 이전 프레임을 지워 남은 공이 화면에 잔상으로 남지 않게 한다.
 for(const id of ['raceCanvas','minimapCanvas']){const c=$(id);if(c){const g=c.getContext('2d');g?.clearRect(0,0,c.width,c.height)}}
 const card=$('winnerCard');if(card)card.classList.remove('show','burst','winner-pop');
 const names=$('winnerNames');if(names)names.innerHTML='';
 renderRank.lastScrollKey='';renderRank.winnerLocked=false;lastRankCount=-1;rankNodes.clear();rankStatusCache.clear();liveRankMemory.clear();remoteBallView.clear();lastRemoteFrameTs=0;
 const rankList=$('rankList');if(rankList)rankList.replaceChildren();
}
const clientId=(crypto?.randomUUID?.()||('c'+Math.random().toString(36).slice(2)));
function sendInteraction(type,detail={}){apiQuiet('interaction',{interaction:{seq:Date.now(),source:clientId,type,...detail}},1800).catch(()=>{})}
function bindSharedInteractions(){
 document.addEventListener('click',e=>{const el=e.target?.closest?.('button,select,input[type=radio],input[type=checkbox]');if(!el||el.disabled)return;sendInteraction('control',{elementId:el.id||'',label:(el.textContent||el.value||'').trim().slice(0,40)})},true);
 const c=$('raceCanvas');if(c)c.addEventListener('pointerdown',e=>{const r=c.getBoundingClientRect();sendInteraction('canvas',{x:clamp((e.clientX-r.left)/Math.max(1,r.width),0,1),y:clamp((e.clientY-r.top)/Math.max(1,r.height),0,1)})},{passive:true});
}
function connectRoomEvents(){
 if(!('EventSource' in window))return;
 try{eventSource?.close()}catch{}
 eventSource=new EventSource('/api/events?room='+encodeURIComponent(room));
 eventSource.onopen=()=>{connectionFailures=0;if($('conn'))$('conn').textContent='실시간 연결됨'};
 eventSource.onmessage=(ev)=>{
  try{
   const packet=JSON.parse(ev.data)||{};
   if(packet.kind==='snapshot'&&packet.snapshot){
    const snap=packet.snapshot,seq=Number(snap.seq||0);
    if(seq>=lastAcceptedSnapshotSeq){
     lastAcceptedSnapshotSeq=seq;remoteSnapshotReceivedAt=performance.now();
     if(!state)state={};state.snapshot=snap;
     if(packet.status)state.status=packet.status;
     if(packet.raceId!=null)state.raceId=packet.raceId;
    }
    return;
   }
   if(packet.kind==='interaction'&&packet.interaction){
    const it=packet.interaction;interactionSeq=Math.max(interactionSeq,Number(it.seq||0));
    if(it.source!==clientId){
     sharedPointer={...it,receivedAt:performance.now()};
     if(it.elementId){const el=document.getElementById(it.elementId);if(el){el.classList.remove('remoteActivated');void el.offsetWidth;el.classList.add('remoteActivated');setTimeout(()=>el.classList.remove('remoteActivated'),420)}}
    }
    return;
   }
   const incoming=packet.state;if(!incoming)return;
   // 통합 사이트에서는 다른 멤버가 바꾼 맵/참가자/설정을 로컬 저장값으로 덮어쓰지 않는다.
   if(localRunning&&sim&&localRaceConfig){
    incoming.status='running';incoming.map=localRaceConfig.map;incoming.raceId=localRaceConfig.raceId;incoming.seed=localRaceConfig.seed;incoming.winMode=localRaceConfig.winMode;incoming.winningRanks=localRaceConfig.ranks;
   }
   // 제어 이벤트는 snapshot을 의도적으로 제외하므로 현재 좌표 프레임을 유지해 화면 점프를 막는다.
   if(state?.snapshot&&!incoming.snapshot)incoming.snapshot=state.snapshot;
   const incomingSeq=Number(incoming?.snapshot?.seq||incoming?.snapshotSeq||0),currentSeq=Number(state?.snapshot?.seq||lastAcceptedSnapshotSeq||0);
   if(incomingSeq&&incomingSeq<currentSeq)incoming.snapshot=state.snapshot;else if(incomingSeq)lastAcceptedSnapshotSeq=incomingSeq;
   if(state?.raceBalls&&!incoming.raceBalls)incoming.raceBalls=state.raceBalls;
   const previousRace=state?.raceId;state=incoming;ui();
   if(role==='admin'&&!localRunning&&state.status==='running'&&!state.winnerDeclared&&!(state.winners||[]).length&&state.raceId!==lastRace&&Number(raceHostId)===Number(state.raceId)){
    startPhysics();localRunning=true;localRaceConfig={map:state.map,raceId:state.raceId,seed:state.seed,winMode:state.winMode,ranks:state.winningRanks||[1]};
   }
   if(previousRace!==state.raceId)lastRankCount=-1;
  }catch(e){console.warn('실시간 상태 처리 실패',e)}
 };
 eventSource.onerror=()=>{if($('conn'))$('conn').textContent='실시간 재연결 중'};
}
async function poll(){
 // 관리자 로컬 물리가 권위 소스인 동안에는 자기 스냅샷을 다시 내려받아 파싱하지 않는다.
 // 네트워크/JSON 작업이 메인 스레드를 막아 공이 중간에 멈추는 현상을 방지한다.
 if(role==='admin'&&localRunning&&sim){setTimeout(poll,350);return}
 if(polling||mutationBusy){setTimeout(poll,140);return}polling=true;try{const r=await fetch('/api/state?room='+room,{cache:'no-store'});if(!r.ok)throw Error('상태 요청 실패');const j=await r.json(),incoming=j.state;if(!incoming)throw Error('상태 데이터 없음');if(performance.now()<serverStateSuppressedUntil&&!localRunning){incoming.status='lobby';incoming.map=selectedMapLock||state?.map||incoming.map;incoming.finishOrder=[];incoming.winners=[];incoming.raceBalls=[];incoming.snapshot={balls:[],rot:[],gate:0,cam:0,camX:W/2,camZoom:.96}}if(localRunning&&sim&&localRaceConfig){incoming.status='running';incoming.map=localRaceConfig.map;incoming.raceId=localRaceConfig.raceId;incoming.seed=localRaceConfig.seed;incoming.winMode=localRaceConfig.winMode;incoming.winningRanks=localRaceConfig.ranks}if(role==='admin'&&!unifiedMode&&selectedMapLock&&!localRunning)incoming.map=selectedMapLock;if(role==='admin'&&!unifiedMode&&!localRunning)applyAdminPrefs(incoming,selectedMapLock||incoming.map);const incomingSeq=Number(incoming?.snapshot?.seq||incoming?.snapshotSeq||0),currentSeq=Number(state?.snapshot?.seq||lastAcceptedSnapshotSeq||0);if(incomingSeq&&incomingSeq<currentSeq)incoming.snapshot=state?.snapshot||incoming.snapshot;else if(incomingSeq)lastAcceptedSnapshotSeq=incomingSeq;state=incoming;connectionFailures=0;if($('conn'))$('conn').textContent='연결됨';ui();if(role==='admin'&&performance.now()>=serverStateSuppressedUntil&&!localRunning&&state.status==='running'&&!state.winnerDeclared&&!(state.winners||[]).length&&state.raceId!==lastRace&&Number(raceHostId)===Number(state.raceId)){startPhysics();localRunning=true;localRaceConfig={map:state.map,raceId:state.raceId,seed:state.seed,winMode:state.winMode,ranks:state.winningRanks||[1]}}}catch(e){connectionFailures++;if($('conn'))$('conn').textContent=connectionFailures>=4?'연결 재시도 중':'연결됨'}finally{polling=false;setTimeout(poll,state?.status==='running'?220:320)}}
function parseBulk(t){return t.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean).map(s=>{const m=s.match(/^(.*?)(?:\s*[xX*×]\s*(\d+))?$/);return{name:(m?.[1]||'').trim(),count:Math.max(1,Number(m?.[2]||1)|0)}}).filter(x=>x.name)}
function bindAdmin(){
 if($('soloBtn'))$('soloBtn').onclick=()=>api('setMode',{mode:'solo'});if($('groupBtn'))$('groupBtn').onclick=()=>api('setMode',{mode:'group'});if($('saveTitle'))$('saveTitle').onclick=()=>api('setTitle',{title:$('titleInput').value});
 $('addBtn').onclick=()=>api('addParticipant',{name:$('nameInput').value,count:+$('countInput').value||1,owner:'ADMIN'}).then(()=>{$('nameInput').value=''});
 $('bulkBtn').onclick=()=>api('bulkAdd',{items:parseBulk($('bulkInput').value),owner:'ADMIN'}).then(()=>{$('bulkInput').value=''});
 $('shuffleBtn').onclick=()=>api('shuffle').then(()=>{lastRankCount=-1;rankRenderAt=0;renderRank(true);flash('공 배치가 메인 화면·미니맵·오른쪽 명단까지 함께 섞였어요!')});
 $('mapSelect').onchange=async()=>{
  const select=$('mapSelect'),map=select.value;
  if(!state||resetInFlight)return;
  const token=++mapChangeToken;
  selectedMapLock=map;pendingMap=map;mutationBusy=true;saveAdminPrefs();
  // 실행 중이거나 Box2D를 불러오는 중이어도 먼저 로컬 물리를 완전히 종료한다.
  // lifecycleEpoch가 바뀌므로 이전 맵의 비동기 초기화 결과는 더 이상 살아나지 않는다.
  restoreLobbyPreview(map,{clearParticipants:false});
  select.disabled=true;ui();flash('맵 전환 중…');
  try{
    const j=await apiQuiet('setMap',{map},6500);
    if(token!==mapChangeToken||!j?.ok)return;
    const participants=j.state?.participants||state.participants||[];
    state=applyAdminPrefs({...makeLobbyState(map),...j.state,map,status:'lobby',participants,finishOrder:[],winners:[],winnerDeclared:false,raceBalls:[],snapshot:{balls:[],rot:[],gate:0,cam:0,camX:W/2,camZoom:.96}},map);
    selectedMapLock=map;pendingMap=null;serverStateSuppressedUntil=performance.now()+1800;connectionFailures=0;
    if($('conn'))$('conn').textContent='연결됨';
    ui();flash('맵 변경 완료 · 바로 실행할 수 있어요');
  }catch(e){
    if(token!==mapChangeToken)return;
    // 서버 동기화가 늦어도 로컬 화면은 선택한 맵의 로비 상태로 유지한다.
    state=applyAdminPrefs(makeLobbyState(map),map);selectedMapLock=map;pendingMap=null;serverStateSuppressedUntil=performance.now()+3500;
    if($('conn'))$('conn').textContent='맵 동기화 재시도 중';
    ui();flash('맵 화면은 변경됐어요 · 서버 연결만 다시 확인 중');
  }finally{
    if(token===mapChangeToken){mutationBusy=false;select.disabled=false;select.value=selectedMapLock||map;ui()}
  }
 };
 // 긴급 안정화: 당첨 기준 '적용'은 서버 통신을 전혀 하지 않는다.
 // 설정은 브라우저 메모리에 즉시 반영되고, 레이스 시작 요청에 함께 실어 보낸다.
 const pushWinDraft=()=>{};
 const saveWin=(mode)=>{const ranks=$('rankNumber').value.split(/[ ,]+/).map(Number).filter(n=>Number.isInteger(n)&&n>0);if(mode==='number'&&!ranks.length){flash('당첨 숫자를 입력해주세요');return}const clean=mode==='number'?[...new Set(ranks)].sort((a,b)=>a-b):[1];winDraft={mode,ranks:clean,dirty:true};pendingWinMode=mode;state.winMode=mode;state.winningRanks=clean;saveAdminPrefs();$('winSaved').textContent='적용 완료';ui();pendingWinMode=null;$('winSaved').textContent='현재 설정: '+(mode==='first'?'당첨: 첫 번째':mode==='last'?'당첨: 마지막':'당첨: '+clean.join(', ')+'번째');flash('당첨 기준 즉시 적용 완료');pushWinDraft()};
 $('applyWin').onclick=()=>{const checked=document.querySelector('input[name=win]:checked');if(!checked)return;saveWin(checked.value)};
 $('startBtn').onclick=()=>{const btn=$('startBtn');if(btn.disabled)return;const winnerCard=$('winnerCard');if(winnerCard)winnerCard.classList.remove('show','burst','winner-pop');winnerPopupFirstSeenAt=0;lastWinnerRace=-1;const total=balls().length;if(!state||total<1){flash('공을 1개 이상 추가해주세요');return}const d=winDraft||{mode:state.winMode,ranks:state.winningRanks||[1]},map=selectedMapLock||$('mapSelect').value;const localRaceId=(Number(state.raceId)||0)+1,localSeed=(Date.now()&2147483647)||1;state.map=map;state.status='running';state.raceId=localRaceId;state.seed=localSeed;state.winMode=d.mode;state.winningRanks=d.mode==='last'?[total]:d.ranks;state.finishOrder=[];state.winners=[];state.snapshot={balls:[],rot:[],cam:0};state.effectProfile='global';localRunning=true;localRaceConfig={map,raceId:localRaceId,seed:localSeed,winMode:d.mode,ranks:state.winningRanks};lastRace=localRaceId;raceHostId=localRaceId;snapshotSeq=0;lastAcceptedSnapshotSeq=0;startPhysics();ui();flash('레이스 시작!');btn.disabled=true;btn.textContent='진행 중';apiQuiet('startRace',{map,winMode:d.mode,ranks:state.winningRanks},5000).then(j=>{if(!j?.ok)throw Error(j?.error||'시작 오류');localRaceConfig.raceId=Number(j.raceId)||localRaceConfig.raceId;raceHostId=localRaceConfig.raceId;localRaceConfig.seed=Number(j.seed)||localRaceConfig.seed;state.raceId=localRaceConfig.raceId;state.seed=localRaceConfig.seed;if(winDraft)winDraft.dirty=false}).catch(e=>{flash('서버 동기화 오류: '+(e?.message||'통신 오류')+' · 화면 레이스는 계속 진행됩니다')}).finally(()=>{btn.disabled=false;btn.textContent='▶ 레이스 시작'})};$('resetBtn').onclick=()=>{
  if(resetInFlight)return;
  resetInFlight=true;mutationBusy=true;
  const btn=$('resetBtn');if(btn){btn.disabled=true;btn.textContent='새 판 준비 중'}
  const keepMap=selectedMapLock||$('mapSelect')?.value||state?.map||'wheel';selectedMapLock=keepMap;saveAdminPrefs();
  // 경기 초기화는 참가자를 유지하고, 맵의 공/순위/카메라/슬로우 상태만 즉시 제거한다.
  restoreLobbyPreview(keepMap,{clearParticipants:false});
  const epoch=lifecycleEpoch;
  mutationBusy=false;resetInFlight=false;if(btn){btn.disabled=false;btn.textContent='경기 초기화'}ui();flash('경기 초기화 완료 · 같은 참가자로 재시작 가능');
  apiQuiet('resetRace',{},8000).then(j=>{
    if(epoch!==lifecycleEpoch||!j?.ok)return;
    const participants=j.state?.participants||state.participants||[];
    state=applyAdminPrefs({...makeLobbyState(keepMap),...j.state,map:keepMap,status:'lobby',participants,finishOrder:[],winners:[],raceBalls:[],snapshot:{balls:[],rot:[],gate:0,cam:0,camX:W/2,camZoom:.96}},keepMap);
    serverStateSuppressedUntil=performance.now()+1200;connectionFailures=0;if($('conn'))$('conn').textContent='연결됨';ui();
  }).catch(()=>{if($('conn'))$('conn').textContent='연결 재시도 중';});
};

$('clearBtn').onclick=async()=>{
 if(resetInFlight||!confirm('참가자를 전체 삭제할까요?'))return;
 resetInFlight=true;mutationBusy=true;
 const btn=$('clearBtn');if(btn){btn.disabled=true;btn.textContent='삭제 중'}
 stopLocalRace({clearParticipants:true});ui();
 try{
  const j=await apiQuiet('clearParticipants',{},8000);
  if(!j?.ok)throw Error(j?.error||'전체 삭제 오류');
  if(j.state)state=j.state;
  ui();flash('참가자 전체 삭제 완료 · 새 참가자를 추가하면 바로 재진행 가능');
 }catch(e){flash('화면 초기화 완료 · 서버 동기화 재시도 중')}
 finally{mutationBusy=false;resetInFlight=false;if(btn){btn.disabled=false;btn.textContent='참가자 전체 삭제'}}
};

 // 참가자 추가·당첨 숫자 설정 등 다른 조작은 현재 선택한 맵을 절대 바꾸지 않는다.
 for(const id of ['nameInput','countInput','addBtn','bulkInput','bulkBtn','rankNumber','applyWin']){
  const el=$(id);if(!el)continue;
  for(const ev of ['pointerdown','mousedown','click','focus','input','keydown'])el.addEventListener(ev,()=>{if($('mapSelect'))selectedMapLock=$('mapSelect').value||selectedMapLock},{capture:true});
 }
 document.querySelectorAll('input[name=win]').forEach(el=>el.addEventListener('pointerdown',()=>{if($('mapSelect'))selectedMapLock=$('mapSelect').value||selectedMapLock},{capture:true}));

 document.querySelectorAll('input[name=win]').forEach(x=>x.addEventListener('change',()=>{pendingWinMode=x.value;document.querySelectorAll('.winChoice').forEach(l=>l.classList.toggle('selected',l.querySelector('input')?.checked));if(x.value==='last'){$('rankNumber').disabled=false;$('rankNumber').value=String(Math.max(1,balls().length));saveWin('last');$('rankNumber').disabled=true}else if(x.value==='first'){$('rankNumber').value='1';$('rankNumber').disabled=true;saveWin('first')}else{$('rankNumber').disabled=false;$('winSaved').textContent='숫자를 입력하고 적용을 눌러주세요'}}));
 $('rankNumber').addEventListener('input',()=>{const numberRadio=document.querySelector('input[name=win][value=number]');if(numberRadio?.checked){pendingWinMode='number';const ranks=$('rankNumber').value.split(/[ ,]+/).map(Number).filter(n=>Number.isInteger(n)&&n>0);winDraft={mode:'number',ranks:[...new Set(ranks)].sort((a,b)=>a-b),dirty:true};$('winSaved').textContent='입력 중 · 적용을 눌러주세요'}});
 $('rankNumber').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();const numberRadio=document.querySelector('input[name=win][value=number]');numberRadio.checked=true;pendingWinMode='number';saveWin('number')}});
}
function flash(t){const m=$('msg');if(!m)return;m.textContent=t;setTimeout(()=>{if(m.textContent===t)m.textContent=''},1800)}
function bindMember(){owner=localStorage.getItem('pin_owner')||'';$('ownerInput').value=owner;$('saveOwner').onclick=()=>{owner=$('ownerInput').value.trim();localStorage.setItem('pin_owner',owner);flash('저장 완료')};$('addBtn').onclick=()=>{owner=$('ownerInput').value.trim();if(owner)api('addParticipant',{name:$('nameInput').value,count:+$('countInput').value||1,owner}).then(()=>{$('nameInput').value=''})};$('bulkBtn').onclick=()=>{owner=$('ownerInput').value.trim();if(owner)api('bulkAdd',{items:parseBulk($('bulkInput').value),owner}).then(()=>{$('bulkInput').value=''})}}
function ownerMark(value){const v=String(value||'').trim().toLowerCase();if(v.includes('야미')||v==='y'||v.includes('yami'))return'Y';if(v.includes('꿀혜')||v==='g'||v.includes('ggul'))return'G';if(v.includes('선하')||v==='m'||v.includes('seonha'))return'M';if(v.includes('도릿')||v==='d'||v.includes('dorit'))return'D';return String(value||'').trim().slice(0,1).toUpperCase()}
function balls(){const a=[];(state?.participants||[]).forEach(p=>{for(let i=1;i<=+p.count;i++)a.push({ballId:p.id+'_'+i,name:p.name,copy:i,owner:p.owner,ownerInitial:p.ownerInitial||ownerMark(p.owner)})});return a}
function orderedBalls(){const a=balls(),rr=rnd((state?.seed||1)+(state?.shuffleNonce||0)*9973);for(let i=a.length-1;i>0;i--){const j=Math.floor(rr()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function previewGridBalls(){
 // 로비 오와열은 서버의 shuffleNonce와 동일한 셔플 순서를 사용한다.
 // 따라서 배치 섞기를 누르면 메인 화면·미니맵·오른쪽 명단이 모두 같은 순서로 즉시 갱신된다.
 const raw=orderedBalls(),max=raw.length;if(!max)return[];
 const maxLine=Math.ceil(max/10),lineDelta=-Math.max(0,Math.ceil(maxLine-5)),S=36,X0=(W-26*S)/2,Y0=300;
 return raw.map((b,i)=>{const line=Math.floor(i/10),wx=9.95+(i%10)*.67+(line%2?0.18:0),wy=(maxLine-line+lineDelta)*1.16;return{...b,x:X0+wx*S,y:Y0+wy*S,r:14,done:false,qualified:false,rank:0,waiting:true}});
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const mapNames={wheel:'🍭 캔디 수레바퀴',greed:'🏺 욕망의 항아리 REMIX'};
function ui(){if(!state)return;refreshNameColors();if($('brand'))$('brand').textContent=state.title;if($('roomCode'))$('roomCode').textContent=state.code;if($('ballCount'))$('ballCount').textContent=balls().length;const modeText=state.mode==='solo'?'개인 핀볼':'단체 핀볼';if($('modeLabel'))$('modeLabel').textContent=modeText;if($('modeBadge')){$('modeBadge').textContent=modeText;$('modeBadge').className=state.mode==='solo'?'solo':'group'};if($('mapBadge'))$('mapBadge').textContent=mapNames[state.map]||state.map;const winText=state.winMode==='first'?'당첨: 첫 번째':state.winMode==='last'?'당첨: 마지막':'당첨: '+(state.winningRanks||[1]).join(', ')+'번째';if($('winBadge'))$('winBadge').textContent=winText;
 if(role==='admin'){$('titleInput').value=state.title;const fixedMap=selectedMapLock||pendingMap||state.map;selectedMapLock=mapNames[fixedMap]?fixedMap:(selectedMapLock||'wheel');$('mapSelect').value=selectedMapLock;$('mapSelect').disabled=false;const shownMode=pendingWinMode||(winDraft?.mode)||state.winMode||'first';const shownRanks=shownMode==='last'?[Math.max(1,balls().length)]:((winDraft?.ranks)||state.winningRanks||[1]);const wr=document.querySelector(`input[name=win][value=${shownMode}]`);if(wr)wr.checked=true;if(!pendingWinMode)$('rankNumber').value=shownRanks.join(',');$('rankNumber').disabled=shownMode!=='number';$('memberLink').textContent=location.origin+'/member.html?room='+state.code;if($('soloBtn'))$('soloBtn').classList.toggle('selected',state.mode==='solo');if($('groupBtn'))$('groupBtn').classList.toggle('selected',state.mode==='group');document.querySelectorAll('.winChoice').forEach(l=>l.classList.toggle('selected',l.querySelector('input')?.checked));if($('winSaved')&&!pendingWinMode){const wt=shownMode==='first'?'당첨: 첫 번째':shownMode==='last'?'당첨: 마지막':'당첨: '+shownRanks.join(', ')+'번째';$('winSaved').textContent='현재 설정: '+wt}}
 if($('participants')){const l=(role==='member'&&!unifiedMode)?(state.participants||[]).filter(p=>p.owner===owner):(state.participants||[]),groups=new Map();for(const p of l){const key=(p.owner||'')+'\u0000'+p.name;const g=groups.get(key)||{name:p.name,owner:p.owner,total:0,ids:[]};g.total+=Number(p.count)||0;g.ids.push(p.id);groups.set(key,g)}const rows=[...groups.values()].sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,'ko'));$('participants').innerHTML=rows.length?rows.map((g,i)=>`<div class=pitem style="--personColor:${getNameColor(g.name,1)};--personSoft:${getNameColor(g.name,.13)}"><span class=personRank>${i+1}</span><span class=colorDot style="--dot:${getNameColor(g.name,1)}"></span><b>${esc(g.name)}</b><div class=ballAdjust data-ids="${g.ids.join(',')}"><button class=countMinus type=button aria-label="공 1개 빼기">−</button><span class=personBallCount><strong>${g.total}</strong><small>개</small></span><button class=countPlus type=button aria-label="공 1개 추가">＋</button><button class=countSet type=button>갯수 조정</button></div></div>`).join(''):'<div class=emptyParticipants>추가된 참가자가 없습니다</div>';if($('participantSummary'))$('participantSummary').textContent=`${rows.length}명 · 총 ${rows.reduce((n,g)=>n+g.total,0)}공`;document.querySelectorAll('.ballAdjust').forEach(box=>{const ids=box.dataset.ids.split(',').filter(Boolean),current=Number(box.querySelector('.personBallCount strong')?.textContent)||0;box.querySelector('.countMinus').onclick=()=>{if(current<=1&&!confirm('이 참가자의 마지막 공까지 뺄까요?'))return;api('adjustParticipantGroup',{ids,delta:-1,owner,admin:role==='admin'})};box.querySelector('.countPlus').onclick=()=>api('adjustParticipantGroup',{ids,delta:1,owner,admin:role==='admin'});box.querySelector('.countSet').onclick=()=>{const raw=prompt('변경할 전체 공 개수를 입력해주세요. (0 입력 시 참가자 삭제)',String(current));if(raw===null)return;const count=Number(raw);if(!Number.isInteger(count)||count<0||count>5000){flash('0~5000 사이의 정수를 입력해주세요');return}if(count===0&&!confirm('이 참가자를 삭제할까요?'))return;api('adjustParticipantGroup',{ids,count,owner,admin:role==='admin'})}})}
 renderWinner();}
function hash(s){let h=2166136261;for(let c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
// 원본 Marble Roulette처럼 참가자 순서 전체를 360도 색상환에 균등 분배한다.
// 같은 이름의 모든 공·이름표·미니맵·순위표는 항상 동일한 색을 사용한다.
function getNameHue(name){
 const key=String(name||'공');
 refreshNameColors();
 if(nameHueMap.has(key))return nameHueMap.get(key);
 const hue=(360/Math.max(1,nameHueMap.size+1))*nameHueMap.size;
 nameHueMap.set(key,hue);return hue;
}
function getNameColor(name,alpha=1){
 return `hsl(${getNameHue(name)} 86% 68% / ${alpha})`;
}
function refreshNameColors(){
 const names=[...new Set((state?.participants||[]).map(p=>String(p.name||'').trim()).filter(Boolean))];
 const signature=names.join('\u0001');
 if(signature===nameColorSignature)return;
 nameColorSignature=signature;nameHueMap.clear();nextNameHueIndex=0;
 const total=Math.max(1,names.length);
 names.forEach((name,index)=>nameHueMap.set(name,(360/total)*index));
}
function rnd(seed){let x=seed>>>0;return()=>{x=Math.imul(1664525,x)+1013904223>>>0;return x/4294967296}}
const BASE_W=900,W=1120,H=5200,R=10;
function seg(x1,y1,x2,y2,b=.42){return{x1,y1,x2,y2,b}}function peg(x,y,r=10,b=.72){return{x,y,r,b}}
const ORIGINAL_WHEEL_STAGE={"title":"Wheel of fortune","goalY":111,"popupY":111.75,"zoomY":106.75,"entities":[{"position":{"x":0,"y":0},"shape":{"type":"polyline","points":[[16.5,-300],[9.25,-300],[9.25,8.5],[2,19.25],[2,26],[9.75,30],[9.75,33.5],[1.25,41],[1.25,53.75],[8.25,58.75],[8.25,63],[9.25,64],[8.25,65],[8.25,99.25],[15.1,106.75],[15.1,111.75]],"rotation":0},"type":"static","props":{"density":1,"angularVelocity":0,"restitution":0}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[16.5,-300],[16.5,9.25],[9.5,20],[9.5,22.5],[17.5,26],[17.5,33.5],[24,38.5],[19,45.5],[19,55.5],[24,59.25],[24,63],[23,64],[24,65],[24,100.5],[16,106.75],[16,111.75]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[12.75,37.5],[7,43.5],[7,49.75],[12.75,53.75],[12.75,37.5]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[14.75,37.5],[14.75,43],[17.5,40.25],[14.75,37.5]]}},{"position":{"x":15.5,"y":30},"shape":{"type":"box","width":0.2,"height":0.2,"rotation":-45},"type":"static","props":{"density":1,"angularVelocity":0,"restitution":1}},{"position":{"x":15.5,"y":32},"type":"static","shape":{"type":"box","width":0.2,"height":0.2,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":15.5,"y":28},"type":"static","shape":{"type":"box","width":0.2,"height":0.2,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":12.5,"y":30},"type":"static","shape":{"type":"box","width":0.2,"height":0.2,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":12.5,"y":32},"type":"static","shape":{"type":"box","width":0.2,"height":0.2,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":12.5,"y":28},"type":"static","shape":{"type":"box","width":0.2,"height":0.2,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":9.4,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":11.3,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":13.2,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":15.1,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":17,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":18.9,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":20.699999999999996,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":22.7,"y":66.6},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":9.4,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":11.3,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":13.2,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":15.1,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":17,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":18.9,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":20.699999999999996,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":22.7,"y":69.1},"type":"static","shape":{"type":"box","width":0.6,"height":0.1,"rotation":-45},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":9.5,"y":92},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":12.75,"y":92},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":16,"y":92},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":19.25,"y":92},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":22.5,"y":92},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":11,"y":95},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":14.25,"y":95},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":17.5,"y":95},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":20.75,"y":95},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":9.5,"y":98},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":12.75,"y":98},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":16,"y":98},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":19.25,"y":98},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":22.5,"y":98},"type":"static","shape":{"type":"box","width":0.25,"height":0.25,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":8,"y":75},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":3.5,"restitution":0}},{"position":{"x":12,"y":75},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-3.5,"restitution":0}},{"position":{"x":16,"y":75},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":3.5,"restitution":0}},{"position":{"x":20,"y":75},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-3.5,"restitution":0}},{"position":{"x":24,"y":75},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":3.5,"restitution":0}},{"position":{"x":14,"y":106.75},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-1.2,"restitution":0}}]};

const ORIGINAL_GREED_STAGE={"title":"욕망의 항아리 REMIX · 원본 낙하 패턴","goalY":91,"popupY":91.8,"zoomY":92.5,"entities":[{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[17,-300],[9,-300],[9,8.5],[2,15],[6,61.5]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[7,67.2],[9,85.2],[8,84.9],[6,84.6],[5,78.6],[4,66.6],[7,67.2]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[17,-300],[17,8.5],[24,15],[20,61.5]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[19,67.2],[17,85.2],[18,84.9],[20,84.6],[21,78.6],[22,66.6],[19,67.2]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[11,77.4],[12,78.6],[12,91.8]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[15,77.4],[14,78.6],[14,91.8]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[12,85.8],[11,86.4],[9,87],[8,87],[6,86.4],[5,85.8],[4,84.6],[3,78.6],[2,66.6],[3,63.6],[4,62.4],[5,61.8],[6,61.5]]}},{"type":"static","position":{"x":0,"y":0},"props":{"density":1,"angularVelocity":0,"restitution":0},"shape":{"type":"polyline","rotation":0,"points":[[14,85.8],[15,86.4],[17,87],[18,87],[20,86.4],[21,85.8],[22,84.6],[23,78.6],[24,66.6],[23,63.6],[22,62.4],[21,61.8],[20,61.5]]}},{"position":{"x":13,"y":20},"type":"static","shape":{"type":"box","width":3,"height":3,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":13,"y":55},"type":"static","shape":{"type":"box","width":3,"height":3,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":8,"y":37},"type":"static","shape":{"type":"box","width":2,"height":2,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":18,"y":37},"type":"static","shape":{"type":"box","width":2,"height":2,"rotation":0.7853981633974483},"props":{"density":1,"angularVelocity":0,"restitution":0}},{"position":{"x":11,"y":12},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-3,"restitution":0}},{"position":{"x":15,"y":12},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":3,"restitution":0}},{"position":{"x":8,"y":87},"type":"kinematic","shape":{"type":"box","width":1,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":6,"y":86.4},"type":"kinematic","shape":{"type":"box","width":1.5,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":4,"y":84.6},"type":"kinematic","shape":{"type":"box","width":1.5,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":3.5,"y":81.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":3,"y":78.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":2.75,"y":75.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":2.5,"y":72.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":2.25,"y":69.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":2,"y":66.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":-10,"restitution":0}},{"position":{"x":18,"y":87},"type":"kinematic","shape":{"type":"box","width":1,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":20,"y":86.4},"type":"kinematic","shape":{"type":"box","width":1.5,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":22,"y":84.6},"type":"kinematic","shape":{"type":"box","width":1.5,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":22.5,"y":81.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":23,"y":78.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":23.25,"y":75.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":23.5,"y":72.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":23.75,"y":69.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}},{"position":{"x":24,"y":66.6},"type":"kinematic","shape":{"type":"box","width":2,"height":0.1,"rotation":0},"props":{"density":1,"angularVelocity":10,"restitution":0}}],"chuteLeft":12,"chuteRight":14,"finalTop":61.5};
function activeOriginalStage(){return state?.map==='greed'?ORIGINAL_GREED_STAGE:ORIGINAL_WHEEL_STAGE}

function buildOriginalStageMap(st,type){
 const S=36,X0=(W-26*S)/2,Y0=300;
 const sx=x=>X0+x*S,sy=y=>Y0+y*S;
 const s=[],p=[],rot=[];
 const addBox=(e)=>{
  const cx=sx(e.position.x),cy=sy(e.position.y),hw=e.shape.width*S,hh=e.shape.height*S,a=Number(e.shape.rotation)||0;
  const ca=Math.cos(a),sn=Math.sin(a),pts=[[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([x,y])=>[cx+x*ca-y*sn,cy+x*sn+y*ca]);
  for(let i=0;i<4;i++){const q=pts[i],r=pts[(i+1)%4];s.push(seg(q[0],q[1],r[0],r[1],e.props.restitution||0))}
 };
 for(const e of st.entities||[]){
  if(e.shape.type==='polyline'){
   const pts=e.shape.points;
   for(let i=0;i<pts.length-1;i++)s.push(Object.assign(seg(sx(pts[i][0]+e.position.x),sy(pts[i][1]+e.position.y),sx(pts[i+1][0]+e.position.x),sy(pts[i+1][1]+e.position.y),e.props.restitution||0),{miniMain:true,original:true}));
  }else if(e.shape.type==='circle'){
   p.push({...peg(sx(e.position.x),sy(e.position.y),e.shape.radius*S,e.props.restitution||0),fun:true,original:true});
  }else if(e.shape.type==='box'){
   if(e.type==='kinematic')rot.push({x:sx(e.position.x),y:sy(e.position.y),len:e.shape.width*2*S,a:Number(e.shape.rotation)||0,spd:(e.props.angularVelocity||0)/60,originalAngularVelocity:e.props.angularVelocity||0,fun:true,original:true});
   else addBox(e);
  }
 }
 const goalY=sy(st.goalY),popupY=sy(Number(st.popupY??st.goalY)),worldH=goalY+420;
 const chuteLeft=sx(Number(st.chuteLeft??15.1)),chuteRight=sx(Number(st.chuteRight??16));
 const top=sy(Number(st.finalTop??100));
 return{type,worldH,s,p,rot,bum:[],kick:[],decor:[],routePts:[],routeWidths:[],cameraStops:[],gate:null,
  effects:globalEffects(),rules:{requireCenterChute:type==='greed'},
  finishY:goalY,goalY,popupY,zoomY:sy(st.zoomY),
  finalZone:{top,left:sx(2),right:sx(24),shoulderLeft:chuteLeft-48,shoulderRight:chuteRight+48,pocketTop:sy(st.zoomY-3),floorLeft:chuteLeft-18,floorRight:chuteRight+18,trapFloorY:sy(st.zoomY-1.2),cleanDropTop:sy(st.zoomY),chuteLeft,chuteRight,gateY:sy(st.zoomY-.5)}};
}
function buildOriginalWheelMap(){return buildOriginalStageMap(ORIGINAL_WHEEL_STAGE,'wheel')}
function buildOriginalGreedMap(){return buildOriginalStageMap(ORIGINAL_GREED_STAGE,'greed')}

// v14.0: 레퍼런스 사이트에서 확인한 Polyline + Kinematic 구조를 적용한 데이터 기반 스테이지.
const REFERENCE_STAGE={
  worldH:6600,
  route:{
    points:[[450,0],[450,430],[360,850],[300,1260],[300,1650],[575,1940],[360,2260],[420,2600],[650,3000],[530,3400],[530,3780],[350,4200],[350,4740],[450,5120],[450,5480]],
    widths:[390,390,420,430,440,520,500,480,530,520,500,470,500,700,700]
  },
  walls:[
    [300,2700,300,3410],[300,3410,420,3550],[420,3550,420,2860],[420,2860,300,2700],
    [475,2780,475,3260],[475,2780,555,2895],[555,2895,505,2990],
    [610,3180,610,3850],[610,3850,720,4000],
    [250,3980,335,4115],[335,4115,335,4380],[650,4050,730,4200],[730,4200,730,4470]
  ],
  pins:[
    [385,1510,8.5],[450,1510,8.5],[515,1510,8.5],[385,1585,8.5],[450,1585,8.5],[515,1585,8.5],
    [360,5350,9],[450,5350,9],[540,5350,9],[378,5455,9],[468,5455,9],[558,5455,9],
    [360,5560,9],[450,5560,9],[540,5560,9],[378,5665,9],[468,5665,9],[558,5665,9]
  ],
  spinners:[
    [275,3920,150,Math.PI/2-.14,.0105],[395,3948,150,Math.PI/2+.14,-.0105],
    [515,3920,150,Math.PI/2-.14,.0105],[635,3948,150,Math.PI/2+.14,-.0105]
  ],
  chevrons:{startX:245,y:4520,count:9,gap:52},
  vGuides:[[245,4770,175],[390,4770,150],[535,4770,175],[680,4770,150]]
};
function buildReferenceStage(s,p,rot,decor,addCorridor,finalTop){
  const st=REFERENCE_STAGE;
  const pts=st.route.points.map((q,i)=>i===st.route.points.length-1?[q[0],finalTop]:q.slice());
  addCorridor(pts,st.route.widths,.22,true);
  for(const w of st.walls)s.push(Object.assign(seg(...w,.31),{miniMain:true}));
  for(const q of st.pins)p.push({...peg(q[0],q[1],q[2],.80),fun:true});
  for(const r of st.spinners)rot.push({x:r[0],y:r[1],len:r[2],a:r[3],spd:r[4],fun:true,mixer:true});
  const c=st.chevrons;for(let i=0;i<c.count;i++){const x=c.startX+i*c.gap;s.push(seg(x,c.y,x+20,c.y+28,.26),seg(x+20,c.y+28,x+40,c.y,.26));}
  for(const [x,y,h] of st.vGuides)s.push(seg(x-34,y,x,y+h,.34),seg(x,y+h,x+34,y,.34));
  for(const y of [650,1180,1880,2480,3300,4140,4700,5480])decor.push({kind:'candy',x:y%2?125:775,y});
  return{routePts:pts,routeWidths:st.route.widths};
}

function mapDef(type,seed=0){
 if(type==='wheel')return buildOriginalWheelMap();
 if(type==='greed')return buildOriginalGreedMap();
 let s=[],p=[],rot=[],bum=[],kick=[],decor=[],routePts=[],routeWidths=[];const mr=rnd((Number(seed)||1)^hash(type));
 const worldH=type==='wheel'?6600:type==='cascade'?8200:7350;
 s.push(seg(72,0,72,worldH+40,.22),seg(BASE_W-72,0,BASE_W-72,worldH+40,.22));
 const addCorridor=(pts,widths,b=.34,slide=false)=>{
  const left=[],right=[];
  for(let i=0;i<pts.length;i++){
   const prev=pts[Math.max(0,i-1)],next=pts[Math.min(pts.length-1,i+1)],dx=next[0]-prev[0],dy=next[1]-prev[1],len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len,w=(widths[i]||widths.at(-1))/2;
   left.push([pts[i][0]+nx*w,pts[i][1]+ny*w]);right.push([pts[i][0]-nx*w,pts[i][1]-ny*w]);
  }
  for(let i=0;i<pts.length-1;i++){
   const gl=seg(left[i][0],left[i][1],left[i+1][0],left[i+1][1],b),gr=seg(right[i][0],right[i][1],right[i+1][0],right[i+1][1],b);
   if(slide){gl.slide=true;gr.slide=true;gl.miniMain=true;gr.miniMain=true}
   s.push(gl,gr)
  }
 };
 const addMixPegs=(y,xs)=>xs.forEach((x,i)=>p.push(peg(x,y+(i%2)*34,9,.82)));
 const finalTop=worldH-1120;
 if(type==='wheel'){
  const built=buildReferenceStage(s,p,rot,decor,addCorridor,finalTop);
  routePts=built.routePts;routeWidths=built.routeWidths;
 }else if(type==='cascade'){
  // 두 번째 맵: 사용자가 그린 길쭉한 핀볼 타워 구조.
  // 좁은 출발 목 → 넓은 직선 몸통 → 하단 회전막대 구간 → 결승 집결부 순서다.
  const pts=[[450,0],[450,620],[450,930],[450,1500],[450,2550],[450,3900],[450,5200],[450,6200],[450,finalTop]];
  const widths=[360,400,720,740,740,735,720,660,620];routePts=pts;routeWidths=widths;addCorridor(pts,widths,.40);
  const addDiamond=(x,y,size,b=.88)=>{const h=size/2;s.push(seg(x,y-h,x+h,y,b),seg(x+h,y,x,y+h,b),seg(x,y+h,x-h,y,b),seg(x-h,y,x,y-h,b))};
  // 상단 목 부분의 얇은 회전 핀볼 막대기 2개.
  rot.push({x:365,y:690,len:165,a:Math.PI/2+.08,spd:.026},{x:535,y:690,len:165,a:Math.PI/2-.08,spd:-.026});
  // 중앙의 청록색 마름모 장애물 배치.
  addDiamond(450,1320,245,.94);
  addDiamond(270,2680,165,.92);addDiamond(630,2680,165,.92);
  addDiamond(450,4200,245,.96);
  // 몸통이 너무 비어 보이지 않도록 작은 회전바를 중간중간 배치한다.
  rot.push({x:265,y:1900,len:145,a:.25,spd:.022},{x:635,y:2150,len:145,a:2.7,spd:-.022});
  rot.push({x:450,y:3300,len:185,a:.9,spd:.020});
  // 하단 양쪽의 짧은 막대들은 모두 실제로 회전하며 공을 안쪽으로 튕긴다.
  for(let i=0;i<8;i++){
   const y=5000+i*165,ang=.58+(i%2)*.12;
   rot.push({x:155,y,len:150,a:-ang,spd:.030+(i%3)*.002});
   rot.push({x:745,y,len:150,a:Math.PI+ang,spd:-.030-(i%3)*.002});
  }
  // 그림 속 아래쪽 긴 막대기 2개도 큰 회전축으로 구현한다.
  rot.push({x:315,y:6100,len:430,a:Math.PI/2+.12,spd:.016},{x:585,y:6100,len:430,a:Math.PI/2-.12,spd:-.016});
  // 긴 막대기 아래에서 공이 중앙 결승 통로로 모이도록 완만한 가이드 벽을 둔다.
  s.push(seg(175,5680,245,6500,.52),seg(725,5680,655,6500,.52));
  s.push(seg(245,6500,365,finalTop,.50),seg(655,6500,535,finalTop,.50));
 }else{
  // 버섯: 가장 길고 복잡한 미로 코스. 루프처럼 크게 돌아 합류하는 구간과 좁은 목이 반복된다.
  const pts=[[450,0],[450,380],[300,760],[600,1120],[600,1580],[300,1940],[300,2440],[600,2800],[600,3300],[285,3680],[615,4100],[615,4580],[310,4960],[310,5480],[590,5860],[450,finalTop]];
  const widths=[720,720,690,720,680,720,670,720,670,720,690,680,720,680,710,640];routePts=pts;routeWidths=widths;addCorridor(pts,widths,.40);
  [680,1450,2250,3050,3900,4750,5600].forEach((y,k)=>{rot.push({x:k%2?620:280,y:y+100,len:105+(k%3)*25,a:k*.55,spd:.024});addMixPegs(y+250,[270,360,450,540,630])});
  bum.push({x:205,y:1750,r:37,kick:1.2},{x:695,y:2700,r:37,kick:1.2},{x:205,y:4020,r:37,kick:1.2},{x:695,y:5350,r:37,kick:1.2});
  for(let y=500;y<finalTop-150;y+=880)decor.push({kind:'mushroom',x:y%1760<880?130:770,y});
 }
 // 세 맵 공통 랜덤 이벤트 구간: 같은 맵도 경기마다 장애물 조합·방향·속도가 달라진다.
 const cameraStops=[];
 const eventTop=900,eventBottom=finalTop-260;
 const eventCount=type==='wheel'?8:type==='cascade'?10:11;
 const eventGap=(eventBottom-eventTop)/Math.max(1,eventCount-1);
 for(let ei=0;ei<eventCount;ei++){
  const y=eventTop+eventGap*ei+(mr()-.5)*180;
  const kind=Math.floor(mr()*8),flip=mr()<.5?-1:1;
  cameraStops.push({y,kind,weight:1+(kind===5||kind===6?0.45:0)});
  if(kind===0){
   // 좌우 교차 회전봉
   rot.push({x:300+(mr()-.5)*55,y:y-35,len:150+mr()*70,a:mr()*Math.PI,spd:flip*(.020+mr()*.018)});
   rot.push({x:600+(mr()-.5)*55,y:y+45,len:150+mr()*70,a:mr()*Math.PI,spd:-flip*(.020+mr()*.018)});
  }else if(kind===1){
   // 삼각 범퍼 군집
   bum.push({x:450,y:y-70,r:29+mr()*10,kick:1.18+mr()*.18});
   bum.push({x:315,y:y+65,r:25+mr()*9,kick:1.16+mr()*.16});
   bum.push({x:585,y:y+65,r:25+mr()*9,kick:1.16+mr()*.16});
  }else if(kind===2){
   // 좌우 방향이 매번 바뀌는 튕김판
   kick.push({x:285,y:y-20,r:34,dir:flip,power:.72+mr()*.25});
   kick.push({x:615,y:y+70,r:34,dir:-flip,power:.72+mr()*.25});
   addMixPegs(y+5,[380,450,520]);
  }else if(kind===3){
   // 지그재그 핀 구간
   for(let j=0;j<7;j++)p.push(peg(255+j*65+(j%2?28:-18),y-115+j*36,8+mr()*3,.86));
  }else if(kind===4){
   // 중앙 대형 회전봉 + 양옆 범퍼
   rot.push({x:450,y,len:230+mr()*85,a:mr()*Math.PI,spd:flip*(.016+mr()*.015)});
   bum.push({x:225,y:y+45,r:27+mr()*8,kick:1.15+mr()*.17},{x:675,y:y-45,r:27+mr()*8,kick:1.15+mr()*.17});
  }else if(kind===5){
   // 엇갈린 회전문: 통과 타이밍에 따라 좌우 진로가 크게 갈린다.
   rot.push({x:335,y:y-42,len:205+mr()*45,a:mr()*Math.PI,spd:flip*(.025+mr()*.013)});
   rot.push({x:565,y:y+58,len:205+mr()*45,a:mr()*Math.PI,spd:-flip*(.025+mr()*.013)});
   p.push(peg(450,y+8,12,.94));
  }else if(kind===6){
   // 범퍼 링: 중앙 또는 바깥쪽으로 연속 튕기며 순위가 섞인다.
   const rr0=115+mr()*30;
   for(let j=0;j<6;j++){const a=j*Math.PI/3+(mr()-.5)*.16;bum.push({x:450+Math.cos(a)*rr0,y:y+Math.sin(a)*rr0,r:24+mr()*7,kick:1.22+mr()*.20})}
   kick.push({x:450,y,r:32,dir:flip,power:.88+mr()*.24});
  }else{
   // 개방형 슬라럼: 긴 대각 벽은 공이 쌓이면 통로 전체를 막을 수 있어 사용하지 않는다.
   // 대신 작은 핀과 짧은 회전봉만 배치해 어느 맵에서도 항상 중앙 통과 폭을 남긴다.
   const side=flip>0?1:-1;
   for(let j=0;j<6;j++)p.push(peg(285+j*66+(j%2?side*20:-side*16),y-92+j*34,8+mr()*2,.88));
   rot.push({x:side>0?310:590,y:y+95,len:118+mr()*26,a:side>0?.35:Math.PI-.35,spd:-side*(.018+mr()*.010)});
  }
 }
 // v13.24 캔디 맵은 랜덤 대형 범퍼·킥·교차 회전문을 사용하지 않는다.
 // 위에서 만든 짧고 느린 측면 믹서만 유지해 중앙 낙하 통로가 언제나 열린다.
 if(type==='wheel'){
  // v13.26: 새로 설계한 FUN 오브젝트만 유지한다. 랜덤 대형 장애물은 제거해 완전 차단을 방지한다.
  p=p.filter(q=>q.fun);
  bum=bum.filter(q=>q.fun);
  kick=[];
  rot=rot.filter(r=>r.fun);
  cameraStops.length=0;
 }
 // v11.6: 출발 직후 공이 첫 장애물에 막혀 한 덩어리로 굳지 않도록
 // 모든 맵의 상단 1100px 구간에서는 회전봉·핀·범퍼·킥 장애물을 제거한다.
 // 외곽 코스 벽은 유지되어 공이 넓게 퍼진 상태로 첫 본구간에 진입한다.
 const topClearY=360;
 p=p.filter(q=>q.y>=topClearY);
 bum=bum.filter(q=>q.y>=topClearY);
 kick=kick.filter(q=>q.y>=topClearY);
 rot=rot.filter(q=>q.y>=topClearY);
 // v13.12: 1번 맵(캔디 수레바퀴) 맨 위 구간의 분홍 범퍼/회전막대는 완전히 제거한다.
 // 작은 핀과 외곽 벽은 유지해 출발 직후 공이 부드럽게 퍼지도록 한다.
 if(type==='wheel'){
  bum=bum.filter(q=>q.y>=1280);
  kick=kick.filter(q=>q.y>=1280);
  rot=rot.filter(q=>q.y>=1280);
 }

 // 실제 메인 게임 맵의 가로폭 확장: 미니맵 표시만 키우는 것이 아니라
 // 모든 벽·코너·장애물·경로 중심 좌표를 900 기준에서 1120 기준으로 변환한다.
 const mapScale=W/BASE_W,mapCx=W/2,baseCx=BASE_W/2,scaleX=x=>mapCx+(x-baseCx)*mapScale;
 s=s.map(g=>({...g,x1:scaleX(g.x1),x2:scaleX(g.x2)}));
 p=p.map(q=>({...q,x:scaleX(q.x)}));
 bum=bum.map(q=>({...q,x:scaleX(q.x)}));
 kick=kick.map(q=>({...q,x:scaleX(q.x)}));
 rot=rot.map(q=>({...q,x:scaleX(q.x),len:q.len*mapScale}));
 decor=decor.map(q=>({...q,x:scaleX(q.x)}));
 routePts=routePts.map(([x,y])=>[scaleX(x),y]);
 routeWidths=routeWidths.map(w=>w*mapScale);
 // 전 맵 공통 안전 보정: 회전 장애물은 현재 코스 폭의 46%보다 길어질 수 없다.
 // 어느 각도로 돌아도 반대편 벽까지 닿지 않아 완전 차단이 생기지 않는다.
 const routeAtY=(yy)=>{
  if(!routePts?.length)return{x:450,w:620};let i=0;while(i<routePts.length-2&&yy>routePts[i+1][1])i++;
  const a=routePts[i],b=routePts[Math.min(i+1,routePts.length-1)],t=clamp((yy-a[1])/Math.max(1,b[1]-a[1]),0,1);
  return{x:a[0]+(b[0]-a[0])*t,w:(routeWidths[i]||520)+((routeWidths[Math.min(i+1,routeWidths.length-1)]||520)-(routeWidths[i]||520))*t};
 };
 rot=rot.map(r=>{const lane=routeAtY(r.y),maxLen=Math.max(82,lane.w*.46);r.len=Math.min(r.len,maxLen);r.x=clamp(r.x,lane.x-lane.w*.27,lane.x+lane.w*.27);return r});
 // v13.5 anti-clump mixer: 상단에서 공이 한쪽 벽으로 몰리기 전에 여러 번 방향을 바꾼다.
 // 중앙 통로는 항상 남겨 두고, 짧은 회전봉과 엇갈린 핀만 추가한다.
 for(const [yy,phase] of [[430,0],[610,1],[805,0],[1010,1]]){
  const lane=routeAtY(yy),half=Math.min(lane.w*.34,300),step=Math.max(82,half/2.8);
  for(let j=-2;j<=2;j++){
   const xx=lane.x+j*step+(phase?(j%2?24:-20):(j%2?-18:22));
   p.push(peg(clamp(xx,128,W-128),yy+(j%2)*34,9,.94));
  }
 }
 for(const [yy,side] of [[520,-1],[735,1],[930,-1],[1140,1]]){
  const lane=routeAtY(yy);
  rot.push({x:lane.x+side*Math.min(lane.w*.22,190),y:yy,len:Math.min(155,lane.w*.28),a:side<0?.35:Math.PI-.35,spd:-side*.028});
 }
 // 같은 높이에 범퍼가 과도하게 몰리는 조합도 제거한다. 중앙에는 최소 공 4개 폭의 통로를 유지한다.
 bum=bum.filter((q,idx)=>{const lane=routeAtY(q.y),centerGap=Math.abs(q.x-lane.x);if(centerGap<92&&q.r>30){const peers=bum.filter((o,j)=>j!==idx&&Math.abs(o.y-q.y)<95&&Math.abs(o.x-lane.x)<150);return peers.length<2}return true});
 // v13.16: 화면을 복잡하게 만들고 공을 산만하게 튕기던 노란 점 핀을 전부 제거한다.
 // 외곽 벽과 청록색 회전 가이드만 남겨 미니맵처럼 단정한 벽면 낙하 흐름을 만든다.
 p=type==='wheel'?p.filter(q=>q.fun):[];
 // 기존 큰 원형 범퍼도 상·중단에서는 제거 상태를 유지한다.
 bum=bum.filter(q=>{
  const lane=routeAtY(q.y),inMiddle=q.y>760&&q.y<finalTop-170;
  const insideCourse=Math.abs(q.x-lane.x)<lane.w*.46;
  return !(inMiddle&&insideCourse&&q.r>=23);
 });
 // 공통 결승: 상단 구조는 유지하고, 마지막에만 공 한 개 폭의 좁은 단일 통로로 정렬한다.
 const mergeTop=finalTop,gateY=worldH-500,exitX=W/2,entryY=gateY+70,chuteHalf=39,chuteLeft=exitX-chuteHalf,chuteRight=exitX+chuteHalf;
 // 상단 폭을 넉넉히 유지하고, 아래쪽까지 완만하게 줄어드는 사다리꼴 벽을 만든다.
 const trapShoulderY=mergeTop+130,trapFloorY=gateY-105;
 const edgeL=90,edgeR=W-90;
 s.push(seg(edgeL,mergeTop,edgeL+12,trapShoulderY,.43),seg(edgeR,mergeTop,edgeR-12,trapShoulderY,.43));
 s.push(seg(edgeL+12,trapShoulderY,235,trapFloorY,.49),seg(edgeR-12,trapShoulderY,W-235,trapFloorY,.49));
 // 바닥을 거의 평평한 얕은 V 형태로 넓게 받아 공이 한 점에 갑자기 뭉치지 않게 한다.
 s.push(seg(235,trapFloorY,exitX-150,entryY-18,.58),seg(W-235,trapFloorY,exitX+150,entryY-18,.58));
 s.push(seg(exitX-150,entryY-18,chuteLeft,entryY,.60),seg(exitX+150,entryY-18,chuteRight,entryY,.60));
 // v13.26 3레인 경쟁부: 두 개의 짧은 가이드가 공을 세 갈래로 나눈 뒤 입구 앞에서 끝난다.
 // 끝부분을 열어 두어 레인끼리 마지막 추월이 가능하고, 어느 레인도 결승구를 막지 않는다.
 const laneGuideTop=mergeTop+210,laneGuideBottom=trapFloorY-125;
 s.push(seg(exitX-205,laneGuideTop,exitX-138,laneGuideBottom,.30));
 s.push(seg(exitX+205,laneGuideTop,exitX+138,laneGuideBottom,.30));
 // 각 레인 하단의 짧은 핀볼 패들. 느리게 회전해 한 공씩 툭 튕기며 순위를 섞는다.
 if(type==='wheel'){
  rot.push({x:exitX-265,y:trapFloorY-210,len:92,a:.38,spd:.0095,fun:true});
  rot.push({x:exitX,y:trapFloorY-175,len:88,a:2.75,spd:-.0088,fun:true});
  rot.push({x:exitX+265,y:trapFloorY-210,len:92,a:Math.PI-.38,spd:-.0095,fun:true});
 }
 // 마지막 통로는 공 한 개만 지나갈 수 있는 폭으로 만들어 툭툭 순차 통과한다.
 s.push(seg(chuteLeft,entryY,chuteLeft,worldH+35,.24),seg(chuteRight,entryY,chuteRight,worldH+35,.24));
 // 모든 내부 구조물은 외벽 안쪽 안전영역에서만 존재하도록 마지막에 강제 보정한다.
 // 중심점뿐 아니라 회전 반경과 구조물 크기까지 계산해 어느 각도에서도 밖으로 나오지 않는다.
 const safeL=112,safeR=W-112,safeT=12,safeB=worldH-12;
 for(let i=2;i<s.length;i++){const g=s[i];g.x1=clamp(g.x1,safeL,safeR);g.x2=clamp(g.x2,safeL,safeR);g.y1=clamp(g.y1,safeT,safeB+40);g.y2=clamp(g.y2,safeT,safeB+40)}
 const keepCircle=q=>{const r=Math.max(0,Number(q.r)||0),m=r+8;q.x=clamp(q.x,safeL+m,safeR-m);q.y=clamp(q.y,safeT+m,safeB-m);return q};
 p=p.map(keepCircle);bum=bum.map(keepCircle);kick=kick.map(keepCircle);
 rot=rot.map(r=>{const edge=Math.max(28,Math.min(r.x-safeL,safeR-r.x,r.y-safeT,safeB-r.y));r.len=Math.min(r.len,Math.max(48,edge*2-18));r.x=clamp(r.x,safeL+r.len/2+9,safeR-r.len/2-9);r.y=clamp(r.y,safeT+r.len/2+9,safeB-r.len/2-9);return r});
 // v13.25: 결승 입구를 막던 회전봉을 완전히 제거한다.
 // 회전봉이 세로로 서는 순간 깔때기 출구 전체를 막아 0/230 상태가 유지되는 구조적 버그가 있었다.
 const gate=null;
 // 광폭 맵 비율에 맞춰 모든 핀볼 오브젝트도 함께 확대한다.
 p.forEach(q=>q.r*=1.18);
 bum.forEach(q=>q.r*=1.18);
 rot.forEach(q=>q.len*=1.04);
 if(gate)gate.len*=1.12;
 return{s,p,rot,bum,kick,decor,cameraStops,routePts,routeWidths,worldH,finishY:worldH-16,finishGateY:mergeTop,finishX:exitX,finalZone:{top:mergeTop,left:edgeL,right:edgeR,shoulderLeft:edgeL+12,shoulderRight:edgeR-12,floorLeft:235,floorRight:W-235,wingLeft:exitX-150,wingRight:exitX+150,pocketTop:trapShoulderY,trapFloorY,gateY,cleanDropTop:entryY,chuteLeft,chuteRight},gate}
}
function startLegacyPhysics(){const physicsEpoch=++lifecycleEpoch;lastRace=state.raceId;const rr=rnd((state.seed||1)+(state.shuffleNonce||0)*9973),raw=balls();for(let i=raw.length-1;i>0;i--){const j=Math.floor(rr()*(i+1));[raw[i],raw[j]]=[raw[j],raw[i]]}
 // 공을 한 지점에서 동시에 쏟지 않고 넓은 폭에 분산한 뒤 아주 짧은 시간차로 출발시킨다.
 const cols=Math.max(14,Math.min(38,Math.ceil(Math.sqrt(Math.max(1,raw.length)*4.2))));
 const now=performance.now(),targetMs=clamp(68000+raw.length*34,76000,106000),spacing=R*2+7;
 // v15.10al: 공이 많아도 결과 연출까지 2분 안쪽을 목표로 하는 적응형 경기 시간.
 // 공 수에 따라 초반 흐름은 유지하되, 60초 이후부터 정체 공에만 단계적으로 배출 보조를 준다.
 // v13.27: 대량 공은 전체 투입 시간이 지나치게 길어지지 않도록 간격을 자동 조절한다.
 const releaseGap=0;
 const arr=raw.map((b,i)=>{const row=Math.floor(i/cols),slot=i%cols,zig=row%2?.5:0,base=cols===1?W/2:125+(slot+zig)*((W-250)/Math.max(1,cols-1));const seed=((state.seed||1)^hash(b.ballId)^((i+1)*2654435761))>>>0;const lane=(slot/(Math.max(1,cols-1))-.5);const releaseJitter=Math.floor(rr()*9);const startY=22-(row%3)*3;return{...b,x:clamp(base+(rr()-.5)*28,116,W-116),y:startY,prevX:0,prevY:startY,vx:lane*.22+(rr()-.5)*.48,vy:.018+rr()*.045,r:R,releaseAt:now,done:false,qualified:false,rank:0,lastMoveAt:now,lastMoveX:0,lastMoveY:startY,stuckCount:0,lastRescueAt:0,ghostUntil:0,stunStart:0,stunUntil:0,stunTriggered:false,stunAnchorY:0,stunCooldownUntil:0,lastWallBounceAt:0,lastGateKickAt:0,lastGateTouchAt:0,gateSide:0,gateContactUntil:0,gateLiftUntil:0,lastFlowBounceAt:0,lastLowerBounceAt:0,lastFinalSeparateAt:0,finalLaneSide:0,finishDropSpeed:0,approachLane:((i+hash(b.ballId))%3),approachSpeed:(.84+rr()*.34),approachPhase:rr()*Math.PI*2,rngState:seed||1}});for(const b of arr){b.prevX=b.x;b.prevY=b.y;b.lastMoveX=b.x;b.lastMoveY=b.y}manualCam=null;sim={balls:arr,map:mapDef(state.map,state.seed),effects:globalEffects(),finish:[],last:now,startedAt:now,targetMs,hardDeadline:118000,acc:0,lastSend:0,paused:false,cam:0,camX:W/2,camZoom:.96,slowRank:0,slowUntil:0,slowedRanks:new Set(),finishFocusUntil:0,finishFlash:null,entrySlowRank:0,entrySlowUntil:0,entrySlowed:new Set(),finishZoomUntil:0,finishZoomStart:0,focusBallId:null,preWinnerFocusRank:0,preWinnerFocusStartedAt:0,preSlowTarget:0,slowScale:1,slowTarget:1,completionSent:false,winnerResolved:false,winnerResolvedAt:0,cameraTargetY:0,cameraTargetX:W/2,cameraTargetZoom:1,cameraHoldUntil:0,cameraLastPick:0,cameraReason:'출발',cameraVelocityY:0,cameraVelocityX:0,bottomCameraLocked:false,bottomCameraLockedAt:0,stunGateCooldownUntil:0,jamWatchAt:now,jamZones:new Map(),lastStepAt:now,chuteActiveBallId:null,chuteNextReleaseAt:now+240};}

async function startOriginalBox2DRace(){
 const physicsEpoch=++lifecycleEpoch;lastRace=state.raceId;
 const rr=rnd((state.seed||1)+(state.shuffleNonce||0)*9973),raw=balls();
 for(let i=raw.length-1;i>0;i--){const j=Math.floor(rr()*(i+1));[raw[i],raw[j]]=[raw[j],raw[i]]}
 const stage=activeOriginalStage(),now=performance.now(),map=buildOriginalStageMap(stage,state.map);
 sim={balls:[],map,effects:globalEffects(),finish:[],last:now,startedAt:now,startReleaseAt:now+900,startEffectsAt:now+2400,targetMs:106000,hardDeadline:118000,acc:0,lastSend:0,paused:false,cam:0,camX:W/2,camZoom:.96,slowRank:0,slowUntil:0,slowedRanks:new Set(),finishFocusUntil:0,finishFlash:null,entrySlowRank:0,entrySlowUntil:0,entrySlowed:new Set(),finishZoomUntil:0,finishZoomStart:0,focusBallId:null,preWinnerFocusRank:0,preWinnerFocusStartedAt:0,preSlowTarget:0,slowScale:1,slowTarget:1,completionSent:false,winnerResolved:false,winnerResolvedAt:0,cameraTargetY:0,cameraTargetX:W/2,cameraTargetZoom:1,cameraHoldUntil:0,cameraLastPick:0,cameraReason:'출발',cameraVelocityY:0,cameraVelocityX:0,bottomCameraLocked:false,bottomCameraLockedAt:0,lastStepAt:now,box2dLoading:true,box2d:null,impactDisabledUntil:now+1500,winnerPopupReady:false,winnerPopupReadyAt:0,winnerPopupNotBefore:0};
 manualCam=null;ui();flash('원본 Box2D 물리 준비 중…');
 const factory=await box2dFactoryPromise;
 if(physicsEpoch!==lifecycleEpoch||!sim||!localRunning)return;
 if(!factory)return startLegacyPhysics();
 try{
  const B=await factory();
  if(physicsEpoch!==lifecycleEpoch||!sim)return;
  const gravity=new B.b2Vec2(0,10),world=new B.b2World(gravity),bodies=new Map(),entities=[];
  const bodyTypes={static:B.b2_staticBody,kinematic:B.b2_kinematicBody};
  for(const e of stage.entities||[]){
   const bd=new B.b2BodyDef();bd.set_type(bodyTypes[e.type]);const body=world.CreateBody(bd);
   const fd=new B.b2FixtureDef();fd.set_density(e.props.density);fd.set_restitution(e.props.restitution);
   if(e.shape.type==='box'){
    const sh=new B.b2PolygonShape();sh.SetAsBox(e.shape.width,e.shape.height,0,e.shape.rotation||0);fd.set_shape(sh);body.CreateFixture(fd);
   }else if(e.shape.type==='circle'){
    const sh=new B.b2CircleShape();sh.set_m_radius(e.shape.radius);fd.set_shape(sh);body.CreateFixture(fd);
   }else if(e.shape.type==='polyline'){
    for(let i=0;i<e.shape.points.length-1;i++){const a=e.shape.points[i],c=e.shape.points[i+1],v1=new B.b2Vec2(a[0],a[1]),v2=new B.b2Vec2(c[0],c[1]),edge=new B.b2EdgeShape();edge.SetTwoSided(v1,v2);body.CreateFixture(edge,1)}
   }
   body.SetAngularVelocity(e.props.angularVelocity||0);body.SetTransform(new B.b2Vec2(e.position.x,e.position.y),0);
   entities.push({body,e});
  }
  const max=raw.length,maxLine=Math.ceil(max/10),lineDelta=-Math.max(0,Math.ceil(maxLine-5));
  const S=36,X0=(W-26*S)/2,Y0=300;
  const arr=raw.map((b,i)=>{
   // 시작 대형을 조금 더 벌려 서로 눌려 멈추지 않고 전 공이 동시에 후두둑 낙하한다.
   const line=Math.floor(i/10),wx=9.95+(i%10)*.67+(line%2?0.18:0),wy=(maxLine-line+lineDelta)*1.16;
   const shape=new B.b2CircleShape();shape.set_m_radius(.25);
   const bd=new B.b2BodyDef();bd.set_type(B.b2_dynamicBody);bd.set_position(new B.b2Vec2(wx,wy));
   const body=world.CreateBody(bd);body.CreateFixture(shape,1+rr());try{body.SetBullet(true)}catch(_){}body.SetAwake(false);body.SetEnabled(false);body.SetLinearVelocity(new B.b2Vec2((rr()-.5)*.28,1.45+rr()*.45));bodies.set(String(b.ballId),body);
   return{...b,x:X0+wx*S,y:Y0+wy*S,prevX:X0+wx*S,prevY:Y0+wy*S,vx:0,vy:0,r:14,releaseAt:sim.startReleaseAt,waiting:true,done:false,qualified:false,rank:0,lastMoveAt:now,lastMoveX:X0+wx*S,lastMoveY:Y0+wy*S,stuckTime:0,skillCoolTime:rr()*1000,skillMaxCoolTime:1000,skillRate:.05+rr()*.55,impactUntil:0};
  });
  sim.balls=arr;sim.skillEffects=[];sim.startDropAssistUntil=sim.startReleaseAt+2200;sim.lastStartDropAssist=0;sim.impactDisabledUntil=sim.startEffectsAt;sim.startBodiesReleased=false;sim.box2d={B,world,bodies,entities,S,X0,Y0,stage,lastStep:performance.now()};sim.box2dLoading=false;
  flash('원본과 같은 Box2D 물리·눈처럼 전체 동시 낙하 적용 완료');
 }catch(e){console.error(e);if(physicsEpoch!==lifecycleEpoch||!sim||!localRunning)return;flash('Box2D 초기화 실패 · 기존 물리로 전환');startLegacyPhysics()}
}
function startPhysics(){
 if(state?.map==='wheel'||state?.map==='greed'){startOriginalBox2DRace();return}
 startLegacyPhysics();
}
function isGreedCenterChutePosition(pos){
 // 욕망의 항아리 중앙 직통로: 한 번 진입한 공은 임팩트 없이 아래로만 배출한다.
 return !!sim?.map?.rules?.requireCenterChute&&pos&&pos.y>=77.15&&pos.x>=11.55&&pos.x<=14.45;
}
// 5배속에서도 공의 중심이 욕망의 항아리 네온 외벽 안쪽에 남도록 하는 실제 경계선 계산.
// 단순 사각형 제한이 아니라 화면에 보이는 좌우 외곽 네온 선의 기울기를 그대로 따른다.
function greedNeonBoundsAtY(y){
 const yy=Number(y);
 if(!Number.isFinite(yy))return null;
 let left=9,right=17;
 if(yy<=8.5){left=9;right=17}
 else if(yy<=15){const t=(yy-8.5)/6.5;left=9+(2-9)*t;right=17+(24-17)*t}
 else if(yy<=61.5){const t=(yy-15)/46.5;left=2+(6-2)*t;right=24+(20-24)*t}
 else if(yy<=66.6){const t=(yy-61.5)/5.1;left=6+(2-6)*t;right=20+(24-20)*t}
 else if(yy<=78.6){const t=(yy-66.6)/12;left=2+(3-2)*t;right=24+(23-24)*t}
 else if(yy<=84.6){const t=(yy-78.6)/6;left=3+(5-3)*t;right=23+(21-23)*t}
 else if(yy<=87){const t=(yy-84.6)/2.4;left=5+(8-5)*t;right=21+(18-21)*t}
 else {left=7.7;right=18.3}
 // 공 반지름(.25)과 고속 충돌 오차를 고려해 네온 선보다 충분히 안쪽을 사용한다.
 return{left:left+.34,right:right-.34};
}
function containGreedBallInsideNeon(body,B,pos,vel){
 if(!canvasDragFastForward||!sim?.map?.rules?.requireCenterChute||!body||!pos)return pos;
 const bounds=greedNeonBoundsAtY(pos.y);if(!bounds)return pos;
 let x=pos.x,y=pos.y,changed=false;
 if(x<bounds.left){x=bounds.left;changed=true}
 else if(x>bounds.right){x=bounds.right;changed=true}
 // 출발 통로 위쪽이나 맵 하단 비정상 좌표도 현재 경기 흐름을 유지한 채 안쪽으로 되돌린다.
 if(y< -1.2){y=-1.2;changed=true}
 if(y>103){y=103;changed=true}
 if(!changed)return pos;
 try{
  body.SetTransform(new B.b2Vec2(x,y),body.GetAngle());
  const inward=x<=bounds.left+.01?Math.abs(vel.x)*.16:x>=bounds.right-.01?-Math.abs(vel.x)*.16:vel.x*.35;
  // 밖으로 튀던 횡방향 에너지만 흡수하고 아래 진행 속도는 유지한다.
  body.SetLinearVelocity(new B.b2Vec2(inward,Math.max(.35,vel.y*.92)));
  return body.GetPosition();
 }catch(_){return pos}
}
function triggerOriginalImpactSkill(sourceBall,sourceBody,P,now){
 const {B,bodies,S,X0,Y0}=P,srcPos=sourceBody.GetPosition();
 if(isGreedCenterChutePosition(srcPos))return;
 for(const [id,body] of bodies){
  if(body===sourceBody)continue;
  const pos=body.GetPosition();if(isGreedCenterChutePosition(pos))continue;const dx=pos.x-srcPos.x,dy=pos.y-srcPos.y,distSq=dx*dx+dy*dy;
  if(distSq>=100||distSq<1e-8)continue;
  const dist=Math.sqrt(distSq),nx=dx/dist,ny=dy/dist;
  // 원본 physics-box2d.ts의 Impact 힘과 같은 반경 10 / 최대 impulse 5 계열.
  const impactScale=canvasDragFastForward?.22:1;
  const power=Math.pow(Math.max(0,1-dist/10),2)*5*impactScale;
  if(power<=0)continue;
  body.ApplyLinearImpulseToCenter(new B.b2Vec2(nx*power,ny*power),true);
 }
 sourceBall.impactUntil=now+380;
}
function stepOriginalBox2D(dt){
 if(!sim?.box2d||sim.paused)return;
 const now=performance.now(),P=sim.box2d,{world,bodies,entities,S,X0,Y0,B}=P,stage=P.stage||activeOriginalStage();
 // 시작 전에는 오와열을 유지하고, 시작 연출 시간이 되면 모든 공의 중력을 한 번에 활성화한다.
 if(!sim.startBodiesReleased&&now>=(sim.startReleaseAt||0)){
  sim.startBodiesReleased=true;
  for(const b of sim.balls){const body=bodies.get(String(b.ballId));if(!body)continue;body.SetEnabled(true);body.SetAwake(true);body.SetLinearVelocity(new B.b2Vec2(0,1.55+rrGlobal()*.35));b.waiting=false;b.releaseAt=now}
 }
 // 원본은 10ms 고정 업데이트, Step(interval, 6, 2) 방식이다.
 const bodyCount=sim.balls?.length||0;
 const velocityIterations=bodyCount>550?3:bodyCount>280?4:6;
 const positionIterations=bodyCount>550?1:2;
 // v15.10al: 초반 물리감은 그대로 두고, 경기 후반에만 전 공 공통 중력을 부드럽게 높인다.
 // 특정 공을 골라 보내는 방식이 아니라 모든 활성 공에 동일하게 적용해 순위 공정성을 유지한다.
 const raceElapsed=Math.max(0,now-(sim.startedAt||now));
 const pace1=clamp((raceElapsed-60000)/28000,0,1),pace2=clamp((raceElapsed-90000)/18000,0,1);
 const adaptiveGravity=10+pace1*2.8+pace2*3.6;
 // v15.10bo: 5배속은 내부 시간만 앞당기는 것이 아니라 실제 낙하 가속도도 강화한다.
 // 고정 5회 물리 스텝에 더해 중력과 하강 속도를 보정해 화면상 공이 확실히 빠르게 내려간다.
 const fastForwardGravity=canvasDragFastForward?Math.max(adaptiveGravity,18.5):adaptiveGravity;
 try{world.SetGravity(new B.b2Vec2(0,fastForwardGravity))}catch(_){ }
 // 빨리감기 중에는 핀볼 옆 회전 구조물도 실제 5배속으로 회전한다.
 // 단, 공을 과하게 튕겨내지 않도록 Impact 힘은 별도로 낮춰 배출 효율을 높인다.
 const kinematicSpeedMul=canvasDragFastForward?2.25:1;
 for(const ent of entities){
  if(ent?.e?.type!=='kinematic')continue;
  const base=Number(ent.e?.props?.angularVelocity)||0;
  try{ent.body.SetAngularVelocity(base*kinematicSpeedMul)}catch(_){ }
 }
 world.Step(dt/1000,velocityIterations,positionIterations);sim.lastStepAt=now
 // 78초 이후 정체되거나 상단에 남은 공에만 약한 하향 보조를 주고, 100초 이후에는 배출을 조금 더 적극적으로 돕는다.
 if(raceElapsed>78000&&now-(sim.lastTwoMinuteAssist||0)>(bodyCount>500?260:340)){
  sim.lastTwoMinuteAssist=now;
  const strong=raceElapsed>100000;
  for(const b of sim.balls){
   if(b.done||b.qualified)continue;
   const body=bodies.get(String(b.ballId));if(!body)continue;
   const pos=body.GetPosition(),vel=body.GetLinearVelocity();
   if(isGreedCenterChutePosition(pos))continue;
   const stalled=(b.stuckTime||0)>650,upper=pos.y<55,slowDown=vel.y<(strong?2.6:1.35);
   if(stalled||upper||slowDown){
    const side=((hash(String(b.ballId))&1)?1:-1)*(strong?.035:.018);
    body.ApplyLinearImpulseToCenter(new B.b2Vec2(side,strong?.20:.10),true);
   }
  }
 }
 const rotEntities=entities.filter(q=>q.e.type==='kinematic');
 for(let i=0;i<sim.map.rot.length;i++){const ent=rotEntities[i];if(ent)sim.map.rot[i].a=ent.body.GetAngle()}
 // 시작 직후 모든 공이 동시에 확실히 낙하하도록, 상단에서 정체된 공에만 짧은 하향 보조를 준다.
 if(now<(sim.startDropAssistUntil||0)&&now-(sim.lastStartDropAssist||0)>140){
  sim.lastStartDropAssist=now;
  for(const [id,body] of bodies){
   const pos=body.GetPosition(),vel=body.GetLinearVelocity();
   if(pos.y<16&&vel.y<1.65)body.ApplyLinearImpulseToCenter(new B.b2Vec2((rrGlobal()-.5)*.06,.20+rrGlobal()*.14),true);
  }
 }
 for(const b of sim.balls){
  if(b.done)continue;const body=bodies.get(String(b.ballId));if(!body)continue;
  let pos=body.GetPosition();
  const inGreedCenterChute=isGreedCenterChutePosition(pos);
  // v15.10bs: 5배속은 속도 벡터를 강제로 5배로 키우지 않고, 동일한 8.333ms 물리 스텝을 5배 더 많이 실행한다.
  // 이 방식은 네온 벽 충돌을 매 스텝 검사하므로 공이 선을 관통해 맵 밖으로 튀는 현상을 막고,
  // 핀볼 경로·튕김·회전 구조물도 모두 실제 시간 기준 5배 빠르게 진행한다.
  const ffWinnerCinematic=!!(sim.focusBallId&&(now<sim.finishZoomUntil||(sim.winnerResolved&&String(sim.focusBallId)===String(b.ballId))));
  if(canvasDragFastForward&&!ffWinnerCinematic&&!b.qualified){
   try{
    const vel=body.GetLinearVelocity();
    // 메인 스레드를 멈추지 않는 빠른 결과 모드: 현재 핀볼 흐름은 유지하면서
    // 아래 방향 속도만 점진적으로 보강한다. 순간이동/수직 덮어쓰기는 하지 않는다.
    const progressY=clamp((pos.y-8)/Math.max(1,(stage.goalY||90)-8),0,1);
    const targetDown=4.2+progressY*3.8;
    if(vel.y<targetDown){
     const addY=Math.min(.42,(targetDown-vel.y)*.075);
     body.ApplyLinearImpulseToCenter(new B.b2Vec2(0,addY),true);
    }
    // 좌우 속도가 과도하면 네온 외벽을 뚫기 쉬우므로 방향감은 남기고 완만하게 감쇠한다.
    if(Math.abs(vel.x)>6.2)body.SetLinearVelocity(new B.b2Vec2(vel.x*.88,vel.y));
    // 터널링을 막기 위한 안전 상한만 적용한다. 진행 방향은 절대 덮어쓰지 않는다.
    const maxPhysicalSpeed=inGreedCenterChute?12.5:10.0;
    const total=Math.hypot(vel.x,vel.y);
    if(total>maxPhysicalSpeed){
     const k=maxPhysicalSpeed/Math.max(.001,total);
     body.SetLinearVelocity(new B.b2Vec2(vel.x*k,vel.y*k));
    }
    // 물리 벽 바깥으로 이미 나간 비정상 좌표만 최후 안전장치로 복귀시킨다.
    // 정상 진행 중에는 이 보정이 작동하지 않으며 네온 선 내부의 충돌 흐름을 그대로 유지한다.
    const minX=.34,maxX=25.66,minY=-1.2,maxY=(stage.goalY||90)+13;
    if(pos.x<minX||pos.x>maxX||pos.y<minY||pos.y>maxY){
     const safeX=clamp(pos.x,minX+.18,maxX-.18);
     const safeY=clamp(pos.y,minY+.25,maxY-.25);
     body.SetTransform(new B.b2Vec2(safeX,safeY),body.GetAngle());
     const vx=pos.x<minX?Math.abs(vel.x)*.22:pos.x>maxX?-Math.abs(vel.x)*.22:vel.x*.55;
     const vy=pos.y<minY?Math.abs(vel.y)*.35:vel.y*.55;
     body.SetLinearVelocity(new B.b2Vec2(vx,vy));
    }
    // 욕망의 항아리는 사각형 맵 범위가 아니라 실제 네온 외곽선 안쪽으로 즉시 복귀시킨다.
    pos=containGreedBallInsideNeon(body,B,pos,body.GetLinearVelocity());
   }catch(_){ }
  }
  if(inGreedCenterChute){
   // 원본 욕망의 항아리처럼 중앙 통로 진입 후에는 인위적인 속도 보정 없이 Box2D 중력으로 자연 낙하한다.
   // Impact 및 5초 정체 해제 impulse만 제외해 통로 안에서 위로 되튀는 현상을 막는다.
   b.stuckTime=0;
  }
  const px=X0+pos.x*S,py=Y0+pos.y*S;
  b.prevX=b.x;b.prevY=b.y;b.vx=(px-b.x)/Math.max(1,dt);b.vy=(py-b.y)/Math.max(1,dt);b.x=px;b.y=py;
  const moved=Math.hypot(b.x-(b.lastMoveX??b.x),b.y-(b.lastMoveY??b.y));
  if(moved<.12)b.stuckTime=(b.stuckTime||0)+dt;else{b.stuckTime=0;b.lastMoveX=b.x;b.lastMoveY=b.y;b.lastMoveAt=now}
  // 원본 Marble.update와 동일: 5초간 거의 움직이지 않으면 무작위 impulse.
  if(!inGreedCenterChute&&b.stuckTime>5000){const rescue=canvasDragFastForward?.28:1;body.ApplyLinearImpulseToCenter(new B.b2Vec2((rrGlobal()*10-5)*rescue,(rrGlobal()*10-5)*rescue),true);b.stuckTime=0}
  // 각 공은 생성 시 5~60% 사이의 고유 확률을 받아 1초마다 Impact 발동을 판정한다.
  b.skillCoolTime=(Number(b.skillCoolTime)||0)-dt;
  if(b.skillCoolTime<=0){b.skillCoolTime=b.skillMaxCoolTime||1000;if(now>=(sim.impactDisabledUntil||0)&&!inGreedCenterChute&&rrGlobal()<((b.skillRate??.2)*(canvasDragFastForward?.28:1)))triggerOriginalImpactSkill(b,body,P,now)}
  const wpY=pos.y,wpX=pos.x;
  const prevWpY=Number.isFinite(b.prevWorldY)?b.prevWorldY:wpY;
  b.prevWorldY=wpY;
  // 욕망의 항아리는 중앙 직통로에 실제로 진입한 공만 순위 경쟁에 포함한다.
  // 한 번 중앙 통로에 들어온 공은 약간 흔들려도 자격을 유지해 프레임 건너뜀으로 판정이 누락되지 않게 한다.
  if(sim?.map?.rules?.requireCenterChute&&wpY>=77.0&&wpX>=11.45&&wpX<=14.55)b.greedCenterQualified=true;
  // 당첨 10개 전 긴장 구간: 항아리 하단 회전바 주변에서는 가까운 공끼리 좌우로만 살짝 비비게 한다.
  // 아래 방향 흐름은 유지하고 위로 강제 발사하지 않아, 들어갈 듯 말 듯한 자연스러운 티키타카만 만든다.
  const tension=tensionWindowInfo();
  if(tension.active&&!inGreedCenterChute&&now-(sim.lastTensionNudge||0)>230){
   const gateY=stage.goalY-10;
   const candidates=sim.balls.filter(q=>!q.done&&!q.qualified&&q!==b).slice(0,220);
   let best=null,bestD=1.35;
   for(const q of candidates){const qb=bodies.get(String(q.ballId));if(!qb)continue;const qp=qb.GetPosition();if(qp.y<gateY-13||qp.y>gateY-1.6)continue;const dx=qp.x-pos.x,dy=qp.y-pos.y,d=Math.hypot(dx,dy);if(d<bestD){best={q,qb,qp,dx,dy,d};bestD=d}}
   if(best&&pos.y>gateY-13&&pos.y<gateY-1.6){
    const dir=(best.dx>=0?-1:1),power=.10+(10-tension.gap)*.012;
    body.ApplyLinearImpulseToCenter(new B.b2Vec2(dir*power,.018),true);
    best.qb.ApplyLinearImpulseToCenter(new B.b2Vec2(-dir*power,.018),true);
    sim.lastTensionNudge=now;
   }
  }
  const greedFinishAllowed=!sim?.map?.rules?.requireCenterChute||!!b.greedCenterQualified;
  const crossedGoal=prevWpY<=stage.goalY&&wpY>stage.goalY;
  const missedFrameFallback=wpY>stage.goalY+.9;
  if(!b.qualified&&greedFinishAllowed&&(crossedGoal||missedFrameFallback)){
   b.qualified=true;b.rank=sim.finish.length+1;b.finishEnteredAt=now;b.finishVisualUntil=now+2600;
   const fin={...b,rank:b.rank};sim.finish.push(fin);
   // 서버 응답을 기다리지 않고 관리자 화면의 체크·순위를 실제 물리 결과와 즉시 동기화한다.
   if(state){state.finishOrder=sim.finish.map(q=>({ballId:q.ballId,name:q.name,copy:q.copy,rank:q.rank}));}
   apiQuiet('finishBall',{ballId:b.ballId}).catch(()=>{});
   if(winningTargetRanks().includes(fin.rank)){
    // 두 맵 공통: 당첨 공을 1.5초 클로즈업한 뒤 숨기고, 메인 구도로 복귀하면서 Winner 팝업을 유지한다.
    const winnerCloseupMs=Number(sim.effects?.winnerCloseupMs)||GLOBAL_PINBALL_EFFECTS.winnerCloseupMs;
    sim.winnerResolved=true;sim.winnerResolvedAt=now;sim.winnerPopupReady=false;sim.winnerPopupReadyAt=0;sim.winnerPopupNotBefore=now+winnerCloseupMs;
    sim.focusBallId=b.ballId;sim.finishFlash=null;sim.finishZoomStart=now;sim.finishZoomUntil=now+winnerCloseupMs;sim.firstWinnerPreview=true;
    delete b.winnerHideAt;b.finishVisualUntil=now+5200;
    sim.bottomCameraLocked=false;sim.cameraHoldUntil=0;manualCam=null;
   }
  }
  if(!b.done&&b.qualified){
   const isWinner=winningTargetRanks().includes(b.rank);
   const winnerCloseupDone=isWinner&&Number.isFinite(Number(b.winnerHideAt))&&now>=Number(b.winnerHideAt);
   if((isWinner&&wpY>stage.goalY+12)||(!isWinner&&wpY>stage.goalY+12)){
    b.done=true;world.DestroyBody(body);bodies.delete(String(b.ballId));
    if(isWinner&&sim.winnerResolved){
     sim.winnerPopupReady=true;sim.winnerPopupReadyAt=Math.max(now,Number(sim.winnerPopupNotBefore||0));sim.firstWinnerPreview=false;
     sim.focusBallId='';sim.finishZoomStart=0;sim.finishZoomUntil=0;
     const mainReturnY=Math.max(0,(sim.map.finalZone?.top??sim.map.finishY-700)-260);
     sim.winnerReturnY=mainReturnY;sim.winnerReturnUntil=now+1500;sim.bottomCameraLocked=false;sim.cameraHoldUntil=0;manualCam=null;
    }
   }
  }
 }
 // v15.10bm: 욕망의 항아리 후반 교착 방지.
 // 오른쪽 순위가 더 이상 증가하지 않은 채 소수의 공이 날개/하단 구조물에 끼면
 // 모든 잔여 공을 동일한 규칙으로 단계적으로 풀어 결과가 반드시 이어지게 한다.
 const liveGreedBalls=sim.balls.filter(q=>!q.done&&!q.qualified&&now>=(q.releaseAt||0));
 if(sim.finish.length!==sim.lastFinishProgressCount){
  sim.lastFinishProgressCount=sim.finish.length;
  sim.lastFinishProgressAt=now;
  sim.greedDeadlockStage=0;
 }
 if(!Number.isFinite(sim.lastFinishProgressAt))sim.lastFinishProgressAt=now;
 if(state?.map==='greed'&&liveGreedBalls.length&&now-(sim.lastGreedDeadlockCheck||0)>320){
  sim.lastGreedDeadlockCheck=now;
  const idleMs=now-(sim.lastFinishProgressAt||now);
  const lateRace=sim.finish.length>=Math.max(1,sim.balls.length-12)||liveGreedBalls.length<=12;
  if(lateRace&&idleMs>1700){
   const stageNo=idleMs>6500?3:idleMs>3900?2:1;
   sim.greedDeadlockStage=Math.max(sim.greedDeadlockStage||0,stageNo);
   const ordered=[...liveGreedBalls].sort((a,b)=>{
    const ba=bodies.get(String(a.ballId)),bb=bodies.get(String(b.ballId));
    const ay=ba?.GetPosition()?.y??-999,by=bb?.GetPosition()?.y??-999;
    return by-ay||String(a.ballId).localeCompare(String(b.ballId));
   });
   ordered.forEach((q,i)=>{
    const qb=bodies.get(String(q.ballId));if(!qb)return;
    const qp=qb.GetPosition(),qv=qb.GetLinearVelocity();
    if(isGreedCenterChutePosition(qp)){
     // 중앙 통로 안에서는 옆으로 튕기지 않고 아래 속도만 보장한다.
     qb.SetLinearVelocity(new B.b2Vec2(qv.x*.35,Math.max(qv.y,stageNo===1?3.2:stageNo===2?5.2:7.0)));
     qb.SetAwake(true);q.stuckTime=0;return;
    }
    const centerX=13.0,dx=clamp((centerX-qp.x)*.055,-.42,.42);
    const side=((hash(String(q.ballId))^(i*17))&1)?1:-1;
    const down=stageNo===1?.34:stageNo===2?.62:.90;
    const sideKick=stageNo===1?.035:stageNo===2?.060:.085;
    qb.ApplyLinearImpulseToCenter(new B.b2Vec2(dx+side*sideKick,down),true);
    if(stageNo>=2)qb.SetLinearVelocity(new B.b2Vec2(clamp(qv.x*.55+dx,-2.2,2.2),Math.max(qv.y,stageNo===2?2.8:4.4)));
    q.stuckTime=0;q.lastMoveAt=now;q.lastMoveX=q.x;q.lastMoveY=q.y;
   });
   // 6.5초 이상 완전히 결과가 멈춘 경우에만, 남은 공 전부를 같은 결승 진입 높이에
   // 좌우 대칭으로 재배치한다. 특정 공을 골라 넣지 않고 기존 선두 순서를 유지한다.
   if(stageNo===3&&now-(sim.lastGreedHardRescue||0)>1800){
    sim.lastGreedHardRescue=now;
    const baseY=Math.max(60,Number(stage.goalY||86)-14.5);
    ordered.forEach((q,i)=>{
     const qb=bodies.get(String(q.ballId));if(!qb)return;
     const lane=(i%2===0?-1:1)*(1.05+Math.floor(i/2)*.72);
     const y=baseY-Math.floor(i/4)*1.35;
     try{qb.SetTransform(new B.b2Vec2(13+lane,y),qb.GetAngle());qb.SetLinearVelocity(new B.b2Vec2(-lane*.16,3.6+i*.08));qb.SetAwake(true)}catch(_){ }
     q.stuckTime=0;q.lastMoveAt=now;
    });
   }
  }
 }
 resolveLastStandingWinner(now);
 if(now-(sim.lastSend||0)>90){sim.lastSend=now;sendSnapshot()}
 const total=sim.balls.length;
 if(sim.finish.length>=total&&!sim.completionSent){sim.completionSent=true;setTimeout(()=>apiQuiet('completeRace').catch(()=>{}),500)}
}
function rrGlobal(){return Math.random()}

function collideSeg(b,g){
 const dx=g.x2-g.x1,dy=g.y2-g.y1,L=dx*dx+dy*dy;if(L<.0001)return false;
 const t=clamp(((b.x-g.x1)*dx+(b.y-g.y1)*dy)/L,0,1),cx=g.x1+t*dx,cy=g.y1+t*dy;
 let nx=b.x-cx,ny=b.y-cy,d=Math.hypot(nx,ny);if(d>=b.r)return false;
 if(d<.0001){nx=-dy;ny=dx;d=Math.hypot(nx,ny)||1}
 const ux=nx/d,uy=ny/d,pen=b.r-d;
 // 아주 작은 겹침 보정만 수행하고, 반사에는 임의 힘을 섞지 않는다.
 b.x+=ux*(pen+.02);b.y+=uy*(pen+.02);
 const vn=b.vx*ux+b.vy*uy;
 if(vn<0){
  const bounce=clamp(Number(g.b)||.48,.18,.72),tx=-uy,ty=ux;
  const vt=b.vx*tx+b.vy*ty;
  b.vx=tx*vt*.992-ux*vn*bounce;
  b.vy=ty*vt*.992-uy*vn*bounce;
  if(g.slide){
   // 경사 외벽에서는 반발보다 아래쪽 접선 운동을 보존해 벽을 타며 자연스럽게 가속한다.
   let dtx=tx,dty=ty;if(dty<0){dtx=-dtx;dty=-dty}
   const slope=Math.abs(dy)/Math.max(1,Math.abs(dx));
   const boost=.010+Math.min(.030,slope*.006);
   b.vx+=dtx*boost;b.vy=Math.max(b.vy,dty*(.105+boost));
  }
 }
 return true;
}
function collidePeg(b,q){
 let nx=b.x-q.x,ny=b.y-q.y,d=Math.hypot(nx,ny),min=b.r+q.r;if(d>=min)return false;
 if(d<.0001){nx=1;ny=0;d=1}
 nx/=d;ny/=d;b.x+=nx*(min-d+.02);b.y+=ny*(min-d+.02);
 const vn=b.vx*nx+b.vy*ny;
 if(vn<0){const bounce=clamp(Number(q.b)||.58,.22,.82);b.vx-=(1+bounce)*vn*nx;b.vy-=(1+bounce)*vn*ny}
 return true;
}
function collideBalls(a,finalOnly=false){
 const grid=new Map(),cs=58,now=performance.now(),fz0=sim?.map?.finalZone;
 // 공간 해시에는 실제 검사 대상만 넣어 1000공에서도 전체쌍 비교가 발생하지 않게 한다.
 const candidates=finalOnly&&fz0?a.filter(b=>!b.done&&now>=(b.releaseAt||0)&&b.y>fz0.pocketTop-90):a;
 for(const b of candidates){if(b.done||now<(b.releaseAt||0))continue;const k=(b.x/cs|0)+','+(b.y/cs|0);(grid.get(k)||grid.set(k,[]).get(k)).push(b)}
 for(const b of candidates){if(b.done||now<(b.releaseAt||0))continue;let gx=b.x/cs|0,gy=b.y/cs|0;
  for(let ix=-1;ix<=1;ix++)for(let iy=-1;iy<=1;iy++)for(const o of grid.get((gx+ix)+','+(gy+iy))||[]){
   if(o===b||o.done||now<(o.releaseAt||0)||o.ballId<b.ballId)continue;
   const fz=sim?.map?.finalZone;
   const inFinal=!!(fz&&b.y>fz.pocketTop-70&&o.y>fz.pocketTop-70);
   const fastPair=!!(fz&&b.fastDrain&&o.fastDrain&&b.y>fz.cleanDropTop-12&&o.y>fz.cleanDropTop-12);
   // 빠른 배출 구간의 일반 공은 서로 압력을 전달하지 않는다.
   // 하나라도 fastDrain이면 충돌 섬에서 제외해 뒤 공이 앞 공을 밀어 올리는 현상을 차단한다.
   if(fz&&(b.fastDrain||o.fastDrain)&&b.y>fz.cleanDropTop-18&&o.y>fz.cleanDropTop-18)continue;
   let dx=o.x-b.x,dy=o.y-b.y,d=Math.hypot(dx,dy),m=b.r+o.r;if(d>=m)continue;
   if(d<.001){const side=((hash(String(b.ballId))+hash(String(o.ballId)))&1)?1:-1;dx=.01*side;dy=.004;d=Math.hypot(dx,dy)}
   const nx=dx/d,ny=dy/d;
   // 공마다 독립된 원형 바디로 겹침을 나눠 가진다. 결승부에서도 충돌을 생략하지 않는다.
   // 겹침을 한 번에 강제로 떼지 않고 여러 작은 솔버 반복으로 풀어 벽을 타고 오르는 흐름을 살린다.
   const correction=fastPair?.10:(inFinal?.50:.72),p=(m-d)*correction+.010;
   b.x-=nx*p;b.y-=ny*p;o.x+=nx*p;o.y+=ny*p;
   const rv=(o.vx-b.vx)*nx+(o.vy-b.vy)*ny;
   if(rv<0){
    const tension=tensionWindowInfo(),tensionPair=!!(tension.active&&inFinal&&fz&&b.y<fz.cleanDropTop-8&&o.y<fz.cleanDropTop-8);
    const oldBvy=b.vy,oldOvy=o.vy;
    const restitution=fastPair?.02:(inFinal?(tensionPair?.30:.18):.56);
    const j=-(1+restitution)*rv*.5;
    b.vx-=j*nx;b.vy-=j*ny;o.vx+=j*nx;o.vy+=j*ny;
    if(!inFinal){
     // 맞닿은 공이 한 몸처럼 눌리지 않도록 접선 방향도 조금 분리한다.
     const tx=-ny,ty=nx,seedSide=((hash(String(b.ballId))^hash(String(o.ballId)))&1)?1:-1;
     const spread=.010+Math.min(.020,(m-d)*.0012);
     b.vx-=tx*spread*seedSide;o.vx+=tx*spread*seedSide;
     // 수직으로 포개진 경우 아래 공이 눌려 고정되지 않도록 충돌 순간에만 약하게 되튄다.
     if(Math.abs(ny)>.52){const lift=.010+Math.abs(rv)*.10;b.vy-=lift*ny;o.vy+=lift*ny}
    }
    if(inFinal){
     // 결승부에서는 압력이 한 덩어리 속도로 평균화되지 않도록 접선 속도를 각 공에 조금씩 보존한다.
     const tx=-ny,ty=nx,relT=(o.vx-b.vx)*tx+(o.vy-b.vy)*ty,fr=relT*(tensionPair?.018:.010);
     b.vx+=fr*tx;b.vy+=fr*ty;o.vx-=fr*tx;o.vy-=fr*ty;
     if(tensionPair){
      // 긴장 구간의 추가 힘은 좌우 성분만 사용하며, 충돌 뒤 강하게 위로 솟는 속도는 제한한다.
      const side=((hash(String(b.ballId))^hash(String(o.ballId)))&1)?1:-1;
      const sideKick=.006+(10-tension.gap)*.0009;
      b.vx-=sideKick*side;o.vx+=sideKick*side;
      b.vy=Math.max(b.vy,Math.min(oldBvy,-.018));
      o.vy=Math.max(o.vy,Math.min(oldOvy,-.018));
     }
    }
   }
  }
 }
}
function winningTargetRanks(){
 const total=sim?.balls?.length||balls().length;
 if(state?.winMode==='first')return[1];
 if(state?.winMode==='last')return total?[total]:[];
 return(state?.winningRanks||[]).filter(n=>n>0&&n<=total);
}
function resolveLastStandingWinner(now){
 if(!sim||sim.winnerResolved||state?.winMode!=='last')return null;
 const total=sim.balls.length;
 if(total<1)return null;
 // 마지막 당첨 모드: 실제 경기 공이 하나만 남는 순간 결과만 먼저 확정한다.
 // 공 자체는 qualified/done 처리하거나 숨기지 않고 물리 월드에 그대로 남겨,
 // Winner 팝업 뒤에서도 혼자 핀볼을 계속 타다가 실제 결승 통로로 들어가게 한다.
 const remaining=sim.balls.filter(b=>!b.done&&!b.qualified&&now>=(b.releaseAt||0));
 if(remaining.length!==1)return null;
 const b=remaining[0];
 b.lastStandingWinner=true;
 b.rank=total;
 b.finishEnteredAt=0;
 b.finishVisualUntil=Infinity;
 delete b.winnerHideAt;
 if(!sim.finish.some(q=>String(q.ballId)===String(b.ballId))){
  sim.finish.push({...b,rank:total,lastStandingWinner:true});
  sim.finish.sort((a,c)=>(a.rank||0)-(c.rank||0));
 }
 if(state){state.finishOrder=sim.finish.map(q=>({ballId:q.ballId,name:q.name,copy:q.copy,rank:q.rank}));}
 sim.winnerResolved=true;
 sim.winnerResolvedAt=now;
 // 결과 팝업은 즉시 띄우되 마지막 공은 삭제하지 않고 계속 물리 진행한다.
 // 동시에 1.8초 동안 마지막 공을 부드럽게 확대해, 갑자기 결과만 뜨는 어색함을 없앤다.
 sim.winnerPopupReady=true;
 sim.winnerPopupReadyAt=now;
 sim.winnerPopupNotBefore=now;
 sim.slowRank=0;
 sim.slowUntil=0;
 sim.slowTarget=1;
 sim.focusBallId=b.ballId;
 sim.finishZoomStart=now;
 sim.finishZoomUntil=now+1800;
 sim.firstWinnerPreview=true;
 sim.finishFlash=null;
 sim.bottomCameraLocked=false;
 sim.cameraHoldUntil=0;
 manualCam=null;
 apiQuiet('finishBall',{ballId:b.ballId}).catch(()=>{});
 return b;
}
function tensionWindowInfo(){
 if(!sim)return{active:false,gap:999,nextRank:1,target:0};
 const nextRank=sim.finish.length+1;
 const target=winningTargetRanks().filter(r=>r>=nextRank).sort((a,b)=>a-b)[0]||0;
 const gap=target?target-nextRank:999;
 return{active:!!target&&gap>=0&&gap<=10,gap,nextRank,target};
}
function updateSlowMotion(now){
 const baseScale=state?.map==='wheel'?1:.7;
 if(!sim||sim.paused)return baseScale;
 // 캔디 수레바퀴의 기본 물리 속도는 항상 1배속으로 유지한다.
 // 당첨공 짧은 낙하 확인 구간에만 별도 슬로우를 적용해 팝업 타이밍과 물리 속도를 분리한다.
 if(sim.winnerResolved&&(state?.winMode||sim?.winMode)!=='last'&&now-(sim.winnerResolvedAt||0)<700)return state?.map==='wheel'?.32:.16;
 // '마지막' 모드는 공이 많거나 경기 후반이어도 전체 게임 속도를 절대 늦추지 않는다.
 // 마지막 한 공이 남아 승자가 확정된 뒤의 당첨 연출에만 위 슬로우가 적용된다.
 if((state?.winMode||sim?.winMode)==='last'){
  sim.firstWinnerPreview=false;sim.focusBallId=null;sim.slowRank=0;sim.slowUntil=0;sim.preSlowTarget=0;
  return baseScale;
 }
 const nextRank=sim.finish.length+1,targets=winningTargetRanks(),fz=sim.map.finalZone;
 const upcoming=targets.filter(r=>r>=nextRank).sort((a,b)=>a-b)[0]||0;
 const remaining=upcoming?upcoming-nextRank:9999;
 const contenders=sim.balls.filter(b=>!b.qualified&&!b.done&&fz&&b.y>fz.gateY-760);
 const earlyTarget=upcoming>0&&upcoming<=8;
 // 앞번호 당첨은 시작과 동시에 초저속 세계에 갇히지 않도록 연출 길이와 강도를 자동 축소한다.
 // 1~4번은 당첨 차례의 공이 결승 접근부에 실제로 도착했을 때만 짧게 느려지고,
 // 5~8번은 마지막 2~3개만 완만하게 슬로우를 시작한다.
 if(earlyTarget){
  sim.preSlowTarget=upcoming;
  const center=fz?(fz.chuteLeft+fz.chuteRight)/2:W/2;
  const lead=contenders.length?contenders.slice().sort((a,b)=>b.y-a.y||Math.abs(a.x-center)-Math.abs(b.x-center))[0]:null;
  const veryEarly=upcoming<=4;
  const startGap=veryEarly?0:Math.min(2,upcoming-1);
  const actuallyNear=!!(lead&&fz&&lead.y>fz.trapFloorY-110);
  if(remaining<=startGap&&actuallyNear){
   if(remaining===0){
    if(String(sim.focusBallId)!==String(lead.ballId)){sim.finishZoomStart=now;sim.cameraHoldUntil=0}
    sim.focusBallId=lead.ballId;sim.finishZoomUntil=now+(veryEarly?3600:5200);sim.firstWinnerPreview=true;
    return veryEarly?.30:.24;
   }
   sim.firstWinnerPreview=false;sim.focusBallId=null;
   return veryEarly?.52:.38;
  }
  sim.firstWinnerPreview=false;sim.focusBallId=null;
  return baseScale;
 }
 // 중후반 번호는 마지막 네 공을 충분히 보여주되 그 이전에는 정상 속도를 유지한다.
 if(upcoming&&remaining>=0&&remaining<=10){
  sim.preSlowTarget=upcoming;
  if(remaining<=3&&contenders.length){
   const center=(fz.chuteLeft+fz.chuteRight)/2;
   const lead=contenders.slice().sort((a,b)=>b.y-a.y||Math.abs(a.x-center)-Math.abs(b.x-center))[0];
   if(lead&&remaining===0){
    if(String(sim.focusBallId)!==String(lead.ballId)){sim.finishZoomStart=now;sim.cameraHoldUntil=0}
    sim.focusBallId=lead.ballId;sim.finishZoomUntil=now+7600;sim.firstWinnerPreview=true;
   }else{sim.firstWinnerPreview=false;sim.focusBallId=null}
  }else{sim.firstWinnerPreview=false;sim.focusBallId=null}
  if(remaining<=3)return remaining===0?.16:.22;
  return .42;
 }
 sim.firstWinnerPreview=false;sim.focusBallId=null;sim.slowRank=0;sim.slowUntil=0;sim.preSlowTarget=0;
 return baseScale;
}
function ballRand(b){let x=b.rngState>>>0;x^=x<<13;x^=x>>>17;x^=x<<5;b.rngState=x>>>0;return(b.rngState>>>0)/4294967296}
function step(dt){
 if(!sim||sim.paused)return;
 if(sim.box2dLoading)return;
 if(sim.box2d){stepOriginalBox2D(dt);return;}
 const now=performance.now(),elapsed=now-sim.startedAt;sim.lastStepAt=now;
 // 메인 구간의 좌/우 점유율을 계산해 한쪽에만 몰릴 때 반대쪽 흐름을 살짝 보강한다.
 // 벽으로 끌어당기는 힘이 아니라, 중앙에서 오른쪽으로도 갈 수 있게 수평 속도만 미세 보정한다.
 const mainActive=sim.balls.filter(q=>!q.done&&now>=(q.releaseAt||0)&&q.y>180&&q.y<(sim.map.finalZone?.top||sim.map.worldH)-120);
 const leftCount=mainActive.filter(q=>q.x<W*.46).length,rightCount=mainActive.filter(q=>q.x>W*.54).length;
 const rightUnderfilled=rightCount+3<leftCount*.82;
 // 공 개수와 무관하게 모든 공에 같은 중력·충돌 규칙을 적용한다.
 const lateBoost=1+clamp((elapsed-sim.targetMs*.58)/(sim.targetMs*.42),0,1)*.82;
 // v15.10al: 88초 이후에는 정체 해제 주기를 단축해 2분 안쪽 마무리를 돕는다.
 const twoMinuteUrgency=clamp((elapsed-88000)/20000,0,1);
 for(const r of sim.map.rot){
  // 모든 회전 장애물도 이전 각도를 저장해 프레임 사이의 이동 궤적 전체를 충돌 검사한다.
  r.prevA=Number.isFinite(r.a)?r.a:0;
  const frameRatio=clamp(dt/16.67,.35,1.45);
  r.a=(r.a+r.spd*frameRatio)%(Math.PI*2);
 }
 if(sim.map.gate){
  const g=sim.map.gate;
  // 결승 회전바는 공의 충격과 무관하게 한 방향, 일정 속도로 계속 회전한다.
  g.spd=-.034;
  // 회전 전 각도를 저장해 프레임 사이를 쓸어가는 충돌까지 검사한다.
  g.prevA=Number.isFinite(g.a)?g.a:0;
  g.a=(g.a+g.spd*clamp(dt/16.67,.35,1.45))%(Math.PI*2);
 }
 for(const b of sim.balls){
  if(b.done||now<(b.releaseAt||0))continue;
  b.prevX=b.x;b.prevY=b.y;
  const moved=Math.hypot(b.x-(b.lastMoveX??b.x),b.y-(b.lastMoveY??b.y));
  if(moved>11){b.lastMoveX=b.x;b.lastMoveY=b.y;b.lastMoveAt=now;b.stuckCount=0}
  // v13.8 전 맵 끼임 방지: 1.35초 이상 제자리인 공은 범퍼 틈에서 자연스럽게 빠져나오게 한다.
  // 첫 구조는 속도만 주고, 반복 정체 때만 아주 짧게 아래·옆으로 위치를 풀어 절대 고정되지 않게 한다.
  const stuckMs=now-(b.lastMoveAt||now);
  if(stuckMs>1350&&now-(b.lastRescueAt||0)>650){
   const side=((hash(String(b.ballId))^(b.stuckCount||0))&1)?1:-1;
   const strength=Math.min(.16,.075+(b.stuckCount||0)*.018);
   b.vx=clamp(b.vx+side*(strength+ballRand(b)*.045),-.34,.34);
   b.vy=Math.max(b.vy,.105+ballRand(b)*.055+twoMinuteUrgency*.075);
   b.stuckCount=(b.stuckCount||0)+1;b.lastRescueAt=now;
   if(stuckMs>2550||b.stuckCount>=3){
    b.x+=side*(18+ballRand(b)*18);
    b.y+=12+ballRand(b)*16;
    b.vx=side*(.12+ballRand(b)*.08);
    b.vy=.13+ballRand(b)*.07;
    b.lastMoveX=b.x;b.lastMoveY=b.y;b.lastMoveAt=now;b.stuckCount=0;
   }
  }
  const fz0=sim.map.finalZone,gate0=sim.map.gate;
  // v13.4: 입구 스턴을 제거해 공이 뭉친 채 멈추거나 말려 올라가지 않게 한다.
  b.stunUntil=0;b.stunTriggered=false;b.stunAnchorY=0;
  const stunned=now<b.stunUntil;
  if(stunned){
   // 제자리에서 잠깐 맞물리는 느낌만 주고 위로 떠오르지는 않는다.
   b.vx*=.90;b.vy*=.82;b.vy+=.00020*dt;
   b.vy=clamp(b.vy,0,.016);
   if(b.stunAnchorY)b.y+=(b.stunAnchorY-b.y)*.08;
  }else{
   if(b.stunTriggered&&now>=(b.stunUntil||0)){b.stunTriggered=false;b.stunAnchorY=0;b.vx+=(ballRand(b)-.5)*.055;b.vy=Math.max(b.vy,.035+ballRand(b)*.025)}
   // v13.20 구간별 낙하 속도: 위쪽은 여유 있게, 하단은 공이 쌓이지 않도록 더 강하게 내려보낸다.
   // 화면 상단 45%는 느린 중력, 중단은 기존 수준, 결승 접근부부터는 빠른 중력을 적용한다.
   const worldHNow=sim.map.worldH||H;
   const lowerStart=fz0?fz0.top-210:worldHNow*.68;
   const upperEnd=worldHNow*.45;
   let zoneGravity=.00068;
   if(b.y<upperEnd)zoneGravity=.00048;
   else if(b.y>lowerStart)zoneGravity=.00106;
   else{
    const gt=clamp((b.y-upperEnd)/Math.max(1,lowerStart-upperEnd),0,1);
    zoneGravity=.00048+(.00068-.00048)*gt;
   }
   b.vy+=zoneGravity*dt*lateBoost;
   b.vx*=.99935;b.vy*=b.y>lowerStart?.99945:.99915;
   if(b.y>lowerStart)b.vy=Math.max(b.vy,.092);
   // v13.24 시간 보장 흐름: 캔디 맵은 45초 이후 서서히 최저 낙하속도를 올린다.
   // 모든 활성 공에 같은 규칙을 적용하며, 90초 전후에는 선두가 결승에 도달할 수 있는 속도를 확보한다.
   if(state.map==='wheel'){ b.vx*=.9996; }
  }
  // v13.5: 중앙 기준으로 양옆 벽에 밀어붙이던 보정을 제거한다.
  // 혼잡할 때는 주변 공의 무게중심 반대쪽으로만 짧게 분산되어 벽에 덩어리로 붙지 않는다.
  const fzFlow=sim.map.finalZone;
  const middleTop=(sim.map.worldH||H)*.20,middleBottom=fzFlow?fzFlow.top-150:(sim.map.worldH||H)*.78;
  // v13.21: 하단 사다리꼴에서 오른쪽이 비면 일부 왼쪽/중앙 공만 빈 공간으로 부드럽게 분산한다.
  // 화면 벽과 동일한 폭을 기준으로 하며, 전체 공을 중앙으로 끌어당기지 않는다.
  const lowerFillTop=sim.map.finalZone?sim.map.finalZone.top-80:worldHNow*.70;
  const lowerFillBottom=sim.map.finalZone?sim.map.finalZone.pocketTop+210:worldHNow*.90;
  if(rightUnderfilled&&b.y>lowerFillTop&&b.y<lowerFillBottom&&b.x<W*.66){
   const laneSeed=(hash(b.ballId)+Math.floor(b.y/85))%5;
   if(laneSeed===0||laneSeed===3){
    const desiredX=W*.70+((hash(b.ballId)%100)/100-.5)*W*.10;
    b.vx=clamp(b.vx+(desiredX-b.x)*.000030*dt,-.13,.13);
   }
  }
  if(rightUnderfilled&&b.y>middleTop-180&&b.y<middleBottom&&b.x<W*.63){
   const chance=(hash(String(b.ballId))+Math.floor(now/650))%7;
   if(chance===0)b.vx+=.010+ballRand(b)*.010;
  }
  if(b.y>middleTop&&b.y<middleBottom){
   let count=0,cx=0,cy=0;
   for(const o of sim.balls){
    if(o===b||o.done||o.qualified)continue;
    const dx=o.x-b.x,dy=o.y-b.y;
    if(Math.abs(dx)<92&&Math.abs(dy)<78){count++;cx+=o.x;cy+=o.y}
   }
   if(count>=4){
    cx/=count;cy/=count;
    let ax=b.x-cx,ay=b.y-cy,len=Math.hypot(ax,ay)||1;
    ax/=len;ay/=len;
    b.vx+=ax*Math.min(.026,.006+count*.0022)+(ballRand(b)-.5)*.006;
    // 위쪽 공의 하중을 그대로 받지 않도록 접촉 군집에서만 아주 짧은 상향 반동을 허용한다.
    b.vy+=Math.min(.010,count*.0014)*(ay<0?-1:.25);
   }
  }
  const prevX=b.x,prevY=b.y;const moveScale=.82;b.x+=b.vx*dt*moveScale;b.y+=b.vy*dt*moveScale;
  // 고정 서브스텝에서 한 번씩만 충돌을 해결한다. 중복 안전 패스와 강제 투영은 사용하지 않는다.
  for(const g of sim.map.s)collideSeg(b,g);
  for(const q of sim.map.p)collidePeg(b,q);
  for(const q of sim.map.bum){
   if(collidePeg(b,{...q,b:.62})){
    const dx=b.x-q.x,dy=b.y-q.y,dd=Math.hypot(dx,dy)||1,boost=(q.kick||1.15)*.055;
    b.vx+=(dx/dd)*boost;b.vy+=(dy/dd)*boost;
   }
  }
  for(const q of sim.map.kick||[]){
   const dx=b.x-q.x,dy=b.y-q.y,dd=Math.hypot(dx,dy);
   if(dd<b.r+q.r&&dd>0){b.vx+=q.dir*q.power*.075;b.vy-=q.power*.035}
  }
  for(const r of sim.map.rot){
   const c=Math.cos(r.a),sn=Math.sin(r.a),bar=seg(r.x-c*r.len/2,r.y-sn*r.len/2,r.x+c*r.len/2,r.y+sn*r.len/2,.42);
   if(collideSeg(b,bar)){
    const rx=b.x-r.x,ry=b.y-r.y,surfaceVX=-r.spd*ry,surfaceVY=r.spd*rx;
    const transfer=canvasDragFastForward?.016:.055;b.vx+=surfaceVX*transfer;b.vy+=surfaceVY*transfer;
   }
  }
  if(sim.map.gate){
   const g=sim.map.gate,c=Math.cos(g.a),sn=Math.sin(g.a),half=g.len/2;
   // 하단 막대는 공을 데리고 회전시키는 장치가 아니라, 닿는 순간 한 번만 밀어내는 장애물이다.
   // 반발력은 낮게 두고 회전 접선속도를 매 프레임 전달하지 않는다.
   const bar=seg(g.pivotX-c*half,g.pivotY-sn*half,g.pivotX+c*half,g.pivotY+sn*half,.20);
   const hitGate=collideSeg(b,bar);
   if(hitGate){
    const rx=b.x-g.pivotX,ry=b.y-g.pivotY;
    const surfaceVX=-g.spd*ry,surfaceVY=g.spd*rx;
    const sm=Math.hypot(surfaceVX,surfaceVY)||1;
    const justTouched=now-(b.lastGateTouchAt||0)>145;
    b.lastGateTouchAt=now;
    if(justTouched&&now-(b.lastGateKickAt||0)>285){
     // 마지막 핀볼 막대에 실제로 걸린 공은 통과로 인정하지 않고 한 번 확실히 위로 반사한다.
     // 접선 방향은 유지하되 막대에 붙어 회전하거나 무한히 말려 올라가지는 않는다.
     const tangentX=surfaceVX/sm;
     b.vx=clamp(b.vx*.35+tangentX*.075,-.24,.24);
     b.vy=-clamp(.115+Math.abs(surfaceVY)*.035,.115,.205);
     b.y=Math.min(b.y,g.pivotY-b.r-7);
     b.gateRejectedUntil=now+520;
     b.lastGateKickAt=now;
    }
    b.vx=clamp(b.vx,-.30,.30);
    b.vy=clamp(b.vy,-.22,.40);
   }
  }
  // 공정 레일 강제 가이드: 외벽과 안쪽 길 사이의 빈 공간으로 빠지지 못하게 한다.
  // 현재 높이의 중심선과 폭을 보간해 모든 공이 동일한 안쪽 코스만 타도록 한다.
  if(sim.map.routePts?.length>1&&b.y<sim.map.finalZone.top){
   const pts=sim.map.routePts,ws=sim.map.routeWidths||[];let i=0;
   while(i<pts.length-2&&b.y>pts[i+1][1])i++;
   const a=pts[i],c=pts[Math.min(i+1,pts.length-1)],dy=Math.max(1,c[1]-a[1]),t=clamp((b.y-a[1])/dy,0,1);
   const cx=a[0]+(c[0]-a[0])*t,w=(ws[i]||ws.at(-1)||500)+((ws[Math.min(i+1,ws.length-1)]||ws.at(-1)||500)-(ws[i]||ws.at(-1)||500))*t;
   const margin=b.r+8,left=cx-w*.47+margin,right=cx+w*.47-margin;
   if(b.x<left){
    const nextY=Math.min(c[1],b.y+42),t2=clamp((nextY-a[1])/dy,0,1);
    const cx2=a[0]+(c[0]-a[0])*t2;
    const w2=(ws[i]||ws.at(-1)||500)+((ws[Math.min(i+1,ws.length-1)]||ws.at(-1)||500)-(ws[i]||ws.at(-1)||500))*t2;
    const left2=cx2-w2*.47+margin,slope=(left2-left)/Math.max(1,nextY-b.y);
    b.x=left;b.vx=clamp(b.vx*.18+slope*Math.max(.090,b.vy)*.82,-.18,.18);b.vy=Math.max(b.vy,.110);b.leftWallRideUntil=now+180;
   }
   // v13.12: 오른쪽 벽을 장시간 강제로 붙잡는 추적 로직을 제거한다.
   // 경계에 닿은 순간에만 벽의 아래쪽 접선 방향을 살짝 보존해 자연스럽게 굴러가게 한다.
   if(b.x>right){
    const c2=pts[Math.min(i+1,pts.length-1)],a2=pts[i],dy2=Math.max(1,c2[1]-a2[1]);
    const nextY=Math.min(c2[1],b.y+42),t2=clamp((nextY-a2[1])/dy2,0,1);
    const cx2=a2[0]+(c2[0]-a2[0])*t2;
    const w2=(ws[i]||ws.at(-1)||500)+((ws[Math.min(i+1,ws.length-1)]||ws.at(-1)||500)-(ws[i]||ws.at(-1)||500))*t2;
    const right2=cx2+w2*.47-margin;
    const slope=(right2-right)/Math.max(1,nextY-b.y);
    b.x=right;
    b.vx=clamp(b.vx*.18+slope*Math.max(.090,b.vy)*.82,-.18,.18);
    // v13.15: 오른쪽 벽에 닿은 공은 공중에 매달리지 않고 중력 방향으로 즉시 낙하한다.
    b.vy=Math.max(b.vy,.115);
    b.rightWallRideUntil=now+180;
   }
  }
  // 벽 밖 이탈도 순위와 무관한 대칭 반사로 처리한다.
  const worldLeft=86+b.r,worldRight=W-86-b.r;
  if(b.x<worldLeft){b.x=worldLeft;if(b.vx<0)b.vx*=-.42}
  if(b.x>worldRight){b.x=worldRight;if(b.vx>0)b.vx*=-.42}
  // 결승부는 실제 사다리꼴 벽의 폭을 높이별로 계산해 공을 항상 내부에 가둔다.
  // 플리퍼에 강하게 맞아도 외곽 빈 공간으로 빠지지 않고 안쪽 벽에 반사되어 다시 코스로 돌아온다.
  const fz=sim.map.finalZone;
  if(fz&&b.y>fz.top-70){
   let left=fz.left,right=fz.right;
   if(b.y<=fz.pocketTop){
    const t=clamp((b.y-fz.top)/Math.max(1,fz.pocketTop-fz.top),0,1);
    left=fz.left+(fz.shoulderLeft-fz.left)*t;right=fz.right+(fz.shoulderRight-fz.right)*t;
   }else if(b.y<=fz.trapFloorY){
    const t=clamp((b.y-fz.pocketTop)/Math.max(1,fz.trapFloorY-fz.pocketTop),0,1);
    left=fz.shoulderLeft+(fz.floorLeft-fz.shoulderLeft)*t;right=fz.shoulderRight+(fz.floorRight-fz.shoulderRight)*t;
   }else if(b.y<=fz.cleanDropTop){
    const t=clamp((b.y-fz.trapFloorY)/Math.max(1,fz.cleanDropTop-fz.trapFloorY),0,1);
    left=fz.floorLeft+(fz.chuteLeft-fz.floorLeft)*t;right=fz.floorRight+(fz.chuteRight-fz.floorRight)*t;
   }else{left=fz.chuteLeft;right=fz.chuteRight}
   const minX=left+b.r+3,maxX=right-b.r-3;
   if(b.x<minX){b.x=minX;if(b.vx<0)b.vx*=-.38}
   // v13.12: 하단 오른쪽 벽도 공을 억지로 붙잡지 않고 충돌 순간에만 접선 방향으로 굴린다.
   if(b.x>maxX){
    const sampleY=Math.min(fz.cleanDropTop,b.y+38);
    let sampleRight=right;
    if(sampleY<=fz.pocketTop){const tt=clamp((sampleY-fz.top)/Math.max(1,fz.pocketTop-fz.top),0,1);sampleRight=fz.right+(fz.shoulderRight-fz.right)*tt}
    else if(sampleY<=fz.trapFloorY){const tt=clamp((sampleY-fz.pocketTop)/Math.max(1,fz.trapFloorY-fz.pocketTop),0,1);sampleRight=fz.shoulderRight+(fz.floorRight-fz.shoulderRight)*tt}
    else if(sampleY<=fz.cleanDropTop){const tt=clamp((sampleY-fz.trapFloorY)/Math.max(1,fz.cleanDropTop-fz.trapFloorY),0,1);sampleRight=fz.floorRight+(fz.chuteRight-fz.floorRight)*tt}
    else sampleRight=fz.chuteRight;
    const sampleMaxX=sampleRight-b.r-3;
    const slope=(sampleMaxX-maxX)/Math.max(1,sampleY-b.y);
    b.x=maxX;
    b.vx=clamp(b.vx*.15+slope*Math.max(.100,b.vy)*.85,-.16,.16);
    // v13.15: 하단 경사벽에서도 아래쪽 속도를 죽이지 않고 '뚝' 떨어지는 무게감을 유지한다.
    b.vy=Math.max(b.vy,.125);
    b.rightWallRideUntil=now+220;
   }
   if(b.y<fz.top-70){b.y=fz.top-70;b.vy=Math.abs(b.vy)*.56+.045}
   // v13.14: 하단 접근부는 왼쪽·중앙·오른쪽 공간을 모두 사용한다.
   // 특히 오른쪽 레인 공은 빈 중앙으로 당기지 않고 오른쪽 경사벽 안쪽을 따라 쪼르르 내려간다.
   if(b.y>fz.pocketTop+10&&b.y<fz.cleanDropTop-18){
    const usable=Math.max(42,(maxX-minX));
    const laneIndex=clamp(Number.isFinite(b.approachLane)?b.approachLane:1,0,2);
    const speedMul=b.approachSpeed||1;
    let targetX;
    if(laneIndex===2){
     // 공 반지름만큼 안쪽 여백을 둔 실제 오른쪽 벽 라인. 높이가 내려갈수록 벽과 함께 자연스럽게 입구 쪽으로 좁아진다.
     targetX=maxX-Math.min(7,Math.max(2,usable*.012));
     const wallGap=Math.abs(b.x-targetX);
     const follow=wallGap<80?.000085:.000045;
     b.vx=clamp(b.vx+(targetX-b.x)*follow*dt,-.115,.115);
     // 벽면에서 튀어 중앙으로 날아가지 않도록 수평 반동만 부드럽게 죽이고, 세로 흐름은 유지한다.
     if(b.x>targetX-14&&b.vx<-.025)b.vx*=.72;
    }else{
     const laneFrac=laneIndex===0?.18:.50;
     targetX=minX+usable*laneFrac;
     const wave=Math.sin(now*.00125+(b.approachPhase||0))*Math.min(4,usable*.015);
     b.vx=clamp(b.vx+(targetX+wave-b.x)*.000040*dt,-.115,.115);
    }
    const laneBase=[.058,.070,.105][laneIndex];
    const targetVy=laneBase*speedMul;
    if(b.vy<targetVy)b.vy+=(targetVy-b.vy)*(laneIndex===2?.085:.030);
    // v13.15: 오른쪽 벽 레인은 낙하 속도 상한으로 감속하지 않는다.
    // 기존 상한 보정이 중력을 상쇄해 풍선처럼 떠 내려오는 원인이었다.
    if(laneIndex!==2){
     const laneCap=(laneBase+.038)*speedMul;
     if(b.vy>laneCap)b.vy+=(laneCap-b.vy)*.048;
    }else if(now<(b.rightWallRideUntil||0)){
     b.vy=Math.max(b.vy,.135*speedMul);
    }
   }
   // 결승 통로에서는 중앙으로 강제 정렬하지 않는다. 벽 반사와 공끼리 충돌로 자연스럽게 순위가 바뀐다.
   if(b.y>fz.trapFloorY){
    // 결승 순번이 아직 멀리 남은 공은 플리퍼를 지난 뒤 통로에서 머물지 않고 빠르게 배출한다.
    // 당첨 3~5개 전부터만 속도를 낮춰 후보 공을 눈으로 확인할 수 있게 한다.
    const nextRankNow=sim.finish.length+1;
    const nextWinnerRank=winningTargetRanks().filter(r=>r>=nextRankNow).sort((a,c)=>a-c)[0]||0;
    const winnerGap=nextWinnerRank?nextWinnerRank-nextRankNow:999;
    const nearWinner=winnerGap<=5;
    const inCleanChute=b.y>=fz.cleanDropTop-8;
    b.fastDrain=!!(inCleanChute&&!nearWinner);
    if(b.fastDrain){
     // 좁은 결승 통로는 한 개 레인만 사용한다. 앞 공을 중심으로 곧게 배출한다.
     const laneX=(fz.chuteLeft+fz.chuteRight)/2;
     b.vx+=(laneX-b.x)*.00055*dt;
     b.vx*=.955;
     b.vy=Math.max(b.vy,.255);
     b.vy=Math.min(b.vy,.345);
    }else{
     b.fastDrain=false;
     b.vx*=.996;
     const finalCap=winnerGap<=1?.064:winnerGap<=3?.078:.092;
     if(b.vy>finalCap)b.vy+=(finalCap-b.vy)*.16;
    }
   }
  }
  if(b.y<-180){b.y=-180;b.vy=Math.abs(b.vy)+.08}
  // v13.25 결승부 재설계: 단일 공 스케줄러와 강제 대기열을 제거한다.
  // 모든 공이 깔때기 경사를 따라 계속 움직이며, 넓어진 출구를 통해 순서대로 자연 배출된다.
  if(fz&&!b.qualified){
   const funnelStart=fz.trapFloorY-55;
   if(b.y>funnelStart){
    const chuteCenter=(fz.chuteLeft+fz.chuteRight)*.5;
    const mergeStart=fz.cleanDropTop-155;
    const mergeT=clamp((b.y-mergeStart)/155,0,1);
    // 입구 직전에서만 부드럽게 중앙 방향을 보태고, 위쪽 공을 한 점으로 빨아들이지 않는다.
    if(mergeT>0){
     const steer=.000025+mergeT*.00014;
     b.vx=clamp(b.vx+(chuteCenter-b.x)*steer*dt,-.18,.18);
    }
    // 통로에 들어온 공은 회전하거나 되튀지 않고 확실히 아래로 빠진다.
    if(b.y>=fz.cleanDropTop-6){
     const minX=fz.chuteLeft+b.r+2,maxX=fz.chuteRight-b.r-2;
     if(minX<maxX)b.x=clamp(b.x,minX,maxX);
     b.vx*=.90;
     b.vy=Math.max(b.vy,.175);
     b.vy=Math.min(b.vy,.36);
     // 공끼리 눌려 정지해도 짧은 시간 안에 다시 흐르도록 최소 낙하력을 유지한다.
     if(now-(b.lastMoveAt||now)>420)b.vy=Math.max(b.vy,.27);
    }else if(b.y>fz.trapFloorY){
     b.vy=Math.max(b.vy,.095);
    }
   }
  }
  // v13.17 안전장치: 미세한 프레임 건너뜀으로 결승선 판정을 놓친 공은 통로 안으로 되돌려 진행을 이어간다.
  if(fz&&!b.qualified&&b.y>sim.map.finishY+35){
   b.x=clamp(b.x,fz.chuteLeft+b.r+2,fz.chuteRight-b.r-2);
   b.y=sim.map.finishY-3;
   b.vx*=.25;
   b.vy=Math.max(.060,Math.min(b.vy,.120));
  }
  // 실제 결승선에 먼저 닿은 순서로만 순위를 확정한다. 통로 안에서는 계속 벽·공 충돌 경쟁이 이어진다.
  if(fz&&!b.qualified&&now>=(b.gateRejectedUntil||0)&&prevY<=sim.map.finishY&&b.y>sim.map.finishY&&b.x>fz.chuteLeft-b.r&&b.x<fz.chuteRight+b.r){
   const preResolvedLastWinner=!!b.lastStandingWinner;
   b.qualified=true;
   b.rank=preResolvedLastWinner?(b.rank||sim.balls.length):(sim.finish.length+1);
   b.finishEnteredAt=now;
   b.finishVisualUntil=now+2600;
   const existingFinish=sim.finish.find(q=>String(q.ballId)===String(b.ballId));
   const fin=existingFinish||{...b,rank:b.rank};
   if(!existingFinish)sim.finish.push(fin);
   const isWinner=winningTargetRanks().includes(fin.rank);
   sim.finishFocusUntil=now+(isWinner&&!preResolvedLastWinner?2200:1200);
   if(isWinner&&!preResolvedLastWinner){
    // 일반 당첨 모드는 기존처럼 당첨 공 클로즈업 후 팝업을 표시한다.
    const winnerCloseupMs=700;
    b.finishVisualUntil=now+5200;
    delete b.winnerHideAt;
    sim.winnerResolved=true;sim.winnerResolvedAt=now;sim.winnerPopupReady=false;sim.winnerPopupReadyAt=0;sim.winnerPopupNotBefore=now+winnerCloseupMs;
    sim.slowRank=0;sim.slowUntil=now+winnerCloseupMs;sim.slowTarget=.32;
    sim.focusBallId=b.ballId;sim.finishZoomStart=now;sim.finishZoomUntil=now+winnerCloseupMs;sim.firstWinnerPreview=true;sim.finishFlash=null;
    sim.bottomCameraLocked=false;sim.cameraHoldUntil=0;manualCam=null;
   }
   if(!preResolvedLastWinner)apiQuiet('finishBall',{ballId:b.ballId}).catch(()=>{});
   if(!isWinner||preResolvedLastWinner){
    // 마지막 한 공은 팝업 뒤에서도 실제 결승 통로를 끝까지 자연스럽게 내려간다.
    b.vx*=.18;b.vy=clamp(b.vy,.022,.060);
   }
  }
  if(b.qualified&&!b.done){
   const winner=winningTargetRanks().includes(b.rank);
   b.vx*=winner?.88:.94;b.vy+=.00010*dt;b.vy=clamp(b.vy,winner?.010:.028,winner?.045:.14);
   const winnerCloseupDone=winner&&Number.isFinite(Number(b.winnerHideAt))&&now>=Number(b.winnerHideAt);
   if((winner&&b.y>sim.map.finishY+440)||(!winner&&(b.y>sim.map.finishY+250||now>(b.finishVisualUntil||0)))){
    b.done=true;
    if(winner&&sim.winnerResolved){
     sim.winnerPopupReady=true;sim.winnerPopupReadyAt=Math.max(now,Number(sim.winnerPopupNotBefore||0));sim.firstWinnerPreview=false;
     if(String(sim.focusBallId)===String(b.ballId)){sim.focusBallId='';sim.finishZoomStart=0;sim.finishZoomUntil=0}
     const mainReturnY=Math.max(0,(sim.map.finalZone?.top??sim.map.finishY-700)-260);
     sim.winnerReturnY=mainReturnY;sim.winnerReturnUntil=now+1500;sim.bottomCameraLocked=false;sim.cameraHoldUntil=0;manualCam=null;
    }
   }
  }
  // v15.10br: 레거시 맵도 수직 속도만 강제로 올리지 않고 현재 이동 벡터 전체를 가속한다.
  // 핀볼 구조물을 타는 좌우 움직임은 유지하면서, 아래 방향 성분과 처리 속도만 확실히 높인다.
  if(canvasDragFastForward&&!winnerCinematic&&!sim.winnerResolved){
   const ffZone=sim.map.finalZone;
   const inLower=!!(ffZone&&b.y>ffZone.top-140);
   const inChute=!!(ffZone&&b.y>=ffZone.cleanDropTop-20);
   const mul=inChute?1.34:(inLower?1.28:1.22);
   b.vx=clamp(b.vx*mul,-(inChute?.34:.62),(inChute?.34:.62));
   b.vy=clamp(b.vy*mul+(inChute?.085:(inLower?.055:.032)),-.42,inChute?2.35:(inLower?1.75:1.22));
   // 배속 중 수치 오차나 강한 충돌로 맵 밖으로 나간 공은 벽 안쪽으로 반사 복귀시킨다.
   const edge=R+5;
   if(b.x<edge){b.x=edge;b.vx=Math.abs(b.vx)*.42}
   else if(b.x>W-edge){b.x=W-edge;b.vx=-Math.abs(b.vx)*.42}
   if(b.y<-R*3){b.y=-R*3;b.vy=Math.abs(b.vy)*.55}
  }
 }
 resolveLastStandingWinner(now);
 const active=sim.balls.filter(b=>!b.done&&now>=(b.releaseAt||0));
 // v12.5: 결승 통로의 강제 대기열·정지·중앙 정렬을 제거한다.
 // 공들은 일반 중력과 공-공 충돌 압력으로 경사벽을 타고 올라갔다가 다시 내려오며 자연스럽게 분리된다.
 // 전 맵 자동 병목 감시: 같은 150px 높이 구간에 공이 많이 몰리고 2.4초 이상 거의 내려가지 않으면
 // 해당 구간의 공 전체를 동일 조건으로 아래·좌우 분산시켜 막힘만 해제한다. 순위를 직접 바꾸는 이동은 하지 않는다.
 if(now-(sim.jamWatchAt||0)>420){
  sim.jamWatchAt=now;const bands=new Map();
  for(const q of active){if(q.qualified||(sim.map.finalZone&&q.y>sim.map.finalZone.trapFloorY-40))continue;const key=Math.floor(q.y/150);(bands.get(key)||bands.set(key,[]).get(key)).push(q)}
  for(const [key,list] of bands){
   if(list.length<Math.max(8,Math.ceil(sim.balls.length*.045)))continue;
   const avgVy=list.reduce((a,q)=>a+Math.abs(q.vy),0)/list.length;
   const stalled=list.filter(q=>now-(q.lastMoveAt||now)>1450).length;
   const ratio=stalled/list.length,prev=sim.jamZones.get(key)||0;
   if(ratio>.42&&avgVy<.105){
    if(!prev)sim.jamZones.set(key,now);
    else if(now-prev>650){
     list.forEach((q,i)=>{const dir=((hash(String(q.ballId))^(i*31))&1)?1:-1;q.vx=clamp(q.vx+dir*(state.map==='wheel'?.035:.070)+dir*ballRand(q)*(state.map==='wheel'?.025:.055),-.32,.32);q.vy=Math.max(q.vy,(state.map==='wheel'?.175:.125)+ballRand(q)*(state.map==='wheel'?.035:.055));q.lastMoveX=q.x;q.lastMoveY=q.y;q.lastMoveAt=now;q.lastRescueAt=now;q.stuckCount=0});
     sim.jamZones.delete(key);
    }
   }else sim.jamZones.delete(key);
  }
 }
 // 개수에 따라 일부 공만 선택하지 않고, 공간 분할 충돌을 모든 공에 동일하게 적용한다.
 // 혼잡한 하단은 작은 반복 솔버로 겹침을 부드럽게 해소해 각 공이 따로 움직이게 한다.
 collideBalls(active);
 if(sim.map.finalZone&&active.some(q=>q.y>sim.map.finalZone.pocketTop-80&&!q.fastDrain))collideBalls(active)
 if(sim.finish.length>=sim.balls.length&&!sim.completionSent){sim.completionSent=true;apiQuiet('completeRace').catch(()=>{})}
 if(sim.balls.every(b=>b.done))sim.paused=true
}
function sendSnapshot(){if(!sim||snapshotInFlight||resetInFlight||mutationBusy)return;const epoch=lifecycleEpoch;snapshotInFlight=true;const activeSim=sim;apiQuiet('snapshot',{seq:++snapshotSeq,raceId:Number(activeSim.raceId||state?.raceId||0),balls:activeSim.balls.filter(b=>!b.done||String(b.ballId)===String(activeSim.focusBallId||'')).map(b=>({ballId:b.ballId,name:b.name,copy:b.copy,owner:b.owner,ownerInitial:b.ownerInitial||ownerMark(b.owner),x:+b.x.toFixed(1),y:+b.y.toFixed(1),done:!!b.done,qualified:!!b.qualified,rank:b.rank||0,vx:+b.vx.toFixed(2),vy:+b.vy.toFixed(2),stunMs:Math.max(0,Math.round(b.stunUntil-performance.now())),impactMs:Math.max(0,Math.round(Number(b.impactUntil||0)-performance.now())),waiting:!!b.waiting||performance.now()<(b.releaseAt||0)})),rot:activeSim.map.rot.map(r=>r.a),gate:activeSim.map.gate?activeSim.map.gate.a:0,cam:+activeSim.cam.toFixed(1),camX:+activeSim.camX.toFixed(1),camZoom:+activeSim.camZoom.toFixed(3)},2500).catch(()=>{}).finally(()=>{if(epoch===lifecycleEpoch)snapshotInFlight=false})}
function drawMap(ctx,map,theme){ctx.strokeStyle=theme.line;ctx.lineWidth=4;ctx.shadowColor=theme.glow;ctx.shadowBlur=10;ctx.lineCap='round';for(const g of map.s){ctx.beginPath();ctx.moveTo(g.x1,g.y1);ctx.lineTo(g.x2,g.y2);ctx.stroke()}ctx.shadowBlur=0;for(const q of map.p){ctx.fillStyle=theme.peg;ctx.beginPath();ctx.arc(q.x,q.y,q.r,0,7);ctx.fill()}for(const q of map.bum){ctx.fillStyle=theme.bump;ctx.beginPath();ctx.arc(q.x,q.y,q.r,0,7);ctx.fill();ctx.strokeStyle=theme.line;ctx.lineWidth=3;ctx.stroke()}for(const q of map.kick||[]){ctx.save();ctx.translate(q.x,q.y);ctx.fillStyle=theme.bump;ctx.globalAlpha=.82;ctx.beginPath();ctx.arc(0,0,q.r,0,7);ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 25px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(q.dir>0?'➜':'➜',0,1);ctx.restore()}for(const d of map.decor||[]){ctx.save();ctx.globalAlpha=.65;ctx.font='42px Arial';ctx.textAlign='center';ctx.fillText(d.kind==='candy'?'🍭':d.kind==='cloud'?'☁️':'🍄',d.x,d.y);ctx.restore()}
 if(map.finishGateY){
  ctx.save();
  ctx.shadowColor=theme.glow;ctx.shadowBlur=18;ctx.strokeStyle=theme.line;ctx.lineWidth=5;
  const mh=map.worldH||H,fx=map.finishX||W/2;ctx.beginPath();ctx.moveTo(fx-62,mh-48);ctx.lineTo(fx-62,mh+8);ctx.moveTo(fx+62,mh-48);ctx.lineTo(fx+62,mh+8);ctx.stroke();
  ctx.shadowBlur=0;ctx.fillStyle='rgba(255,255,255,.9)';ctx.font='900 22px Arial';ctx.textAlign='center';
  ctx.fillText('FINISH',fx,mh-82);
  ctx.restore();
 }
}
const themes={wheel:{bg:'#180b25',line:'#ffb6e7',glow:'#ff7bd5',peg:'#ffe675',bump:'#ff91c8'},greed:{bg:'#100a1d',line:'#d8b6ff',glow:'#9d63ff',peg:'#ffd782',bump:'#8fffe0'},cascade:{bg:'#07182b',line:'#b8edff',glow:'#79d7ff',peg:'#fff',bump:'#a8e8ff'},maze:{bg:'#102417',line:'#bff6a8',glow:'#86e56e',peg:'#ffd36f',bump:'#ff9d72'}};
function smoothRemoteSource(source,ts){
 if(role==='admin')return source;
 const dt=Math.min(50,Math.max(4,ts-(lastRemoteFrameTs||ts-16)));lastRemoteFrameTs=ts;
 const age=clamp(ts-(remoteSnapshotReceivedAt||ts),0,180);
 const ease=1-Math.exp(-dt/58),seen=new Set(),out=[];
 for(const b of source){
  const id=String(b.ballId||b.id||b.name),vx=Number(b.vx)||0,vy=Number(b.vy)||0;
  // 서버 프레임 사이에는 마지막 속도로 짧게 예측해 60fps로 계속 움직이고,
  // 새 좌표가 오면 부드럽게 오차만 보정한다.
  const predict=b.waiting?0:age*.78,targetX=Number(b.x)+vx*predict,targetY=Number(b.y)+vy*predict;
  const old=remoteBallView.get(id)||{x:targetX,y:targetY,vx,vy};
  old.x+=(targetX-old.x)*ease;old.y+=(targetY-old.y)*ease;old.vx=vx;old.vy=vy;old.seen=ts;
  remoteBallView.set(id,old);seen.add(id);out.push({...b,x:old.x,y:old.y});
 }
 for(const [id,v] of remoteBallView){if(!seen.has(id)&&ts-(v.seen||0)>700)remoteBallView.delete(id)}
 return out;
}
// v15.10aq: 사용자가 직접 복사한 욕망의 항아리 카메라 좌표.
// 결승 구간을 메인으로 오래 보여주고, 중간중간 중앙 입구로 올라가 다른 공 상태를 확인한다.
const GREED_CAMERA_FINAL={x:566.25,y:2900.99,zoom:.9459};
const GREED_CAMERA_STATUS={x:560.18,y:2383.24,zoom:.9403};
// 날개 핀볼 중계 화면: 중앙 상태 좌표와 같은 높이를 유지하고 X축만 이동한다.
// 좌표 전환은 drawFrame의 지수 보간을 그대로 사용해 순간이동 없이 부드럽게 이어진다.
const GREED_CAMERA_LEFT_WING={x:300.00,y:2383.24,zoom:.9403};
const GREED_CAMERA_RIGHT_WING={x:830.00,y:2383.24,zoom:.9403};
function greedCameraPreset(now,sim,forceFinal=false,allowFixed=true){
 // v15.10aw: 결승 카메라는 사용자가 직접 복사한 정확한 좌표를 사용한다.
 // 다만 하단에 영구 고정하지 않고, 후반 경쟁 구간에서 5초 간격 중계 프리셋의
 // 핵심 포인트로 순환한다. 실제 당첨공 연출에서는 이 프리셋이 호출되지 않는다.
 if(!allowFixed&&!forceFinal)return null;
 if(forceFinal)return {...GREED_CAMERA_FINAL,reason:'결승'};
 if(!sim)return {...GREED_CAMERA_FINAL,reason:'결승'};
 if(!Number.isFinite(sim.greedFixedCameraStartedAt)||sim.greedFixedCameraStartedAt<=0){
  sim.greedFixedCameraStartedAt=now;
 }
 const elapsed=Math.max(0,now-sim.greedFixedCameraStartedAt);
 const hold=5000;
 const shots=[
  {...GREED_CAMERA_FINAL,reason:'결승'},
  {...GREED_CAMERA_STATUS,reason:'욕망의 항아리 중앙 입구 당첨 준비'},
  {...GREED_CAMERA_LEFT_WING,reason:'왼쪽 날개 핀볼'},
  {...GREED_CAMERA_FINAL,reason:'결승'},
  {...GREED_CAMERA_RIGHT_WING,reason:'오른쪽 날개 핀볼'},
  {...GREED_CAMERA_FINAL,reason:'결승'}
 ];
 return shots[Math.floor(elapsed/hold)%shots.length];
}
function greedEntryAnchorCam(){return GREED_CAMERA_FINAL.y}
function greedEntryAnchorX(){return GREED_CAMERA_FINAL.x}
// 욕망의 항아리 카메라 후보 선정:
// 단순 공 평균/진행률이 아니라 실제 중앙 입구에 먼저 도달할 가능성이 높은 공을 고른다.
// 입구와의 거리, 아래쪽 진행도, 하강 속도, 중앙 통로 정렬 여부를 함께 점수화한다.
function pickGreedCameraCandidate(active,map){
 const entryY=map?.finalZone?.cleanDropTop??map?.finalZone?.gateY;
 const entryX=greedEntryAnchorX(map);
 if(!Number.isFinite(entryY))return null;
 const approachTop=Math.max(map?.finalZone?.top??entryY-1450,entryY-1450);
 let best=null,bestScore=-Infinity;
 for(const b of active||[]){
  if(!b||b.done||!Number.isFinite(b.x)||!Number.isFinite(b.y))continue;
  if(b.y<approachTop||b.y>entryY+100)continue;
  const dy=clamp((b.y-approachTop)/Math.max(1,entryY-approachTop),0,1);
  const center=1-clamp(Math.abs(b.x-entryX)/520,0,1);
  const vy=Number.isFinite(b.vy)?b.vy:0;
  const downward=clamp((vy+.12)/1.25,0,1);
  const qualified=(b.greedCenterQualified||b.qualified)?1:0;
  const belowPenalty=b.y>entryY?clamp((b.y-entryY)/100,0,1):0;
  const score=dy*.50+center*.30+downward*.12+qualified*.18-belowPenalty*.45;
  if(score>bestScore){bestScore=score;best=b}
 }
 return best;
}

function drawFrame(ts){const c=$('raceCanvas');if(!c)return;const sourceCount=(role==='admin'&&sim?sim.balls.length:(state?.snapshot?.balls||[]).length);const d=Math.min(devicePixelRatio||1,sourceCount>180?1:sourceCount>90?1.25:1.5),w=c.clientWidth,h=c.clientHeight;if(c.width!==Math.round(w*d)||c.height!==Math.round(h*d)){c.width=Math.round(w*d);c.height=Math.round(h*d)}const x=c.getContext('2d');x.setTransform(d,0,0,d,0,0);const theme=themes[state?.map||'wheel'];x.fillStyle=theme.bg;x.fillRect(0,0,w,h);
 if(sharedPointer&&performance.now()-sharedPointer.receivedAt<650&&sharedPointer.type==='canvas'){
  const life=(performance.now()-sharedPointer.receivedAt)/650,px=Number(sharedPointer.x)*w,py=Number(sharedPointer.y)*h;
  x.save();x.globalAlpha=1-life;x.strokeStyle='#ffffff';x.lineWidth=3;x.beginPath();x.arc(px,py,12+life*34,0,Math.PI*2);x.stroke();x.restore();
 }
 let source=role==='admin'&&sim?sim.balls:(state?.snapshot?.balls||[]),map=role==='admin'&&sim?sim.map:mapDef(state?.map||'wheel',state?.seed||1);
 if((state?.status||'lobby')!=='running'&&!source.length)source=previewGridBalls();
 source=smoothRemoteSource(source,ts);const denseMode=source.length>180;
 // v12.3: 당첨자가 확정되거나 레이스가 정지된 뒤에는 자동복구가 새 물리 월드를 만들지 않는다.
 if(role==='admin'&&sim&&localRunning&&!sim.paused&&!sim.winnerResolved&&!document.hidden&&ts-(sim.lastStepAt||ts)>12000){
  // 경기 상태를 새로 만들면 체크/순위가 0으로 돌아가므로 절대 startPhysics()로 재시작하지 않는다.
  // 긴 프레임 뒤에는 누적 시간만 버리고 현재 월드에서 정상 진행을 이어간다.
  console.warn('긴 프레임 감지: 현재 물리 월드 유지');
  sim.last=ts;sim.acc=0;sim.lastStepAt=ts;
 }
 if(role==='admin'&&sim&&(localRunning||state?.status==='running')&&!sim.paused&&!document.hidden){
  let delta=Math.min(34,Math.max(0,ts-sim.last));sim.last=ts;
  // 5배속은 고정 물리 서브스텝으로만 처리해 타이머 중복 가속과 상태 꼬임을 막는다.
  // v11.5: 슬로우 중에도 물리 업데이트 횟수는 그대로 유지하고, 한 스텝의 시간량만 줄인다.
  // 따라서 프레임을 건너뛰는 렉 느낌 없이 움직임 자체가 매끄럽게 느려진다.
  sim.slowTarget=updateSlowMotion(ts);
  const ease=1-Math.exp(-delta/920);
  sim.slowScale+=(sim.slowTarget-sim.slowScale)*ease;
  sim.slowScale=clamp(sim.slowScale,.14,1);
  // 5배속 표시 중에도 한 화면 프레임에서 Box2D를 10회 이상 몰아서 계산하면
  // 브라우저 메인 스레드가 잠기고 watchdog이 경기를 새로 시작하는 문제가 생긴다.
  // 물리 스텝은 프레임당 최대 3회로 제한하고, 실제 결과 가속은 중력/회전체/배출 보조로 처리한다.
  const fastForwardCinematicBlocked=!!(sim.focusBallId&&(ts<(sim.finishZoomUntil||0)||(sim.winnerResolved&&sim.balls.some(b=>String(b.ballId)===String(sim.focusBallId)&&b.qualified&&!b.done))));
  const userSpeed=(canvasDragFastForward&&!fastForwardCinematicBlocked)?1.85:1;
  sim.acc=Math.min(34,sim.acc+delta*sim.slowScale*userSpeed);
  const physicsStep=8.333;let ffLoops=0;
  const maxLoops=canvasDragFastForward?3:4;
  while(sim.acc>=physicsStep&&ffLoops<maxLoops){step(physicsStep);sim.acc-=physicsStep;ffLoops++}
  if(sim.acc>physicsStep*1.5)sim.acc=physicsStep*1.5;
  const snapshotGap=sim.balls.length>800?260:sim.balls.length>500?220:sim.balls.length>250?170:110;if(ts-sim.lastSend>snapshotGap){sim.lastSend=ts;sendSnapshot()}
 }
 const mh=map.worldH||H,renderBaseScale=Math.min((w-250)/W,1.02),bottomViewWorld=h/Math.max(.01,renderBaseScale*.86),bottomFixedCam=clamp((map.gate?.pivotY||map.finalZone?.gateY||mh-500)-bottomViewWorld*.49,0,Math.max(0,mh-bottomViewWorld+40));let active=source.filter(b=>!b.done),ys=active.map(b=>b.y).sort((a,b)=>a-b);
 const q=(r)=>ys.length?ys[Math.min(ys.length-1,Math.floor((ys.length-1)*r))]:mh-200;
 // 현재 목표 당첨 순번까지의 진행률. 예: 목표 55번, 현재 30번이면 약 55% 진행.
 let cameraNextRank=sim?.finish?.length?sim.finish.length+1:1,cameraTargetRank=0,cameraProgress=0;
 if(role==='admin'&&sim){
  const cameraUpcoming=winningTargetRanks().filter(r=>r>=cameraNextRank).sort((a,b)=>a-b);
  cameraTargetRank=cameraUpcoming[0]||0;
  cameraProgress=cameraTargetRank?clamp((cameraNextRank-1)/Math.max(1,cameraTargetRank-1),0,1):0;
 }
 // 선두 한 명이 아니라 앞쪽 35% 공 무리의 중앙값을 따라가 카메라가 옆으로 튀지 않게 한다.
 const leadCut=ys.length?q(.68):0,leadGroup=active.filter(b=>b.y>=leadCut).sort((a,b)=>a.x-b.x);
 const median=(arr,key,fallback)=>arr.length?arr[Math.floor((arr.length-1)/2)][key]:fallback;
 let focusY=q(.74),targetCam=clamp(focusY-h*.43,0,mh-h+40),nearFinish=q(.80)>mh-820;
 if(role==='admin'&&sim&&map.finalZone&&map.type!=='greed'&&!sim.bottomCameraLocked){
  const bottomEntrants=active.filter(b=>b.y>=map.finalZone.top-110);
  // 목표 당첨이 멀리 남아 있을 때는 하단에 고정하지 않고, 중간 지형과 하단을 오가며 보여준다.
  const allowBottomLock=!cameraTargetRank||cameraProgress>=.82;
  if(allowBottomLock&&(bottomEntrants.length>=2||active.some(b=>b.y>=map.finalZone.top+40))){
   sim.bottomCameraLocked=true;sim.bottomCameraLockedAt=performance.now();sim.cameraHoldUntil=0;manualCam=null;
  }
 }
 const bottomCameraLocked=!!(role==='admin'&&sim?.bottomCameraLocked);
 const focusWinnerBall=(role==='admin'&&sim?.focusBallId)?active.find(b=>String(b.ballId)===String(sim.focusBallId)):null;
 const greedCameraCandidate=map.type==='greed'?pickGreedCameraCandidate(active,map):null;
 const winnerCinematic=!!(focusWinnerBall&&(performance.now()<sim.finishZoomUntil||(sim.winnerResolved&&focusWinnerBall.qualified&&!focusWinnerBall.done)));
 const stops=map.cameraStops||[];let bestStop=null,bestScore=-1;
 const nowCam=performance.now();
 const startBaseAt=(sim?.startReleaseAt||sim?.startedAt||nowCam);
 const startElapsed=Math.max(0,nowCam-startBaseAt);
 const startTopCamera=!!(role==='admin'&&sim&&startElapsed<900);
 // 욕망의 항아리는 시작 직후 하단으로 점프하지 않고, 실제로 떨어지는 선두 공 흐름을 따라 약 6.5초간 내려온다.
 const startFlowCamera=!!(role==='admin'&&sim&&map.type==='greed'&&startElapsed>=900&&startElapsed<6500&&!winnerCinematic);
 if(startTopCamera||startFlowCamera){sim.bottomCameraLocked=false;sim.cameraHoldUntil=0;manualCam=null}
 if(startTopCamera){sim.cameraTargetY=0;sim.cameraTargetX=W/2;sim.cameraTargetZoom=1}
 // 당첨 순번 10개 전부터 결승 입구를 대놓고 크게 확대해 실제로 어떤 공이 떨어지는지 보여준다.
 let preWinnerFocus=false,preWinnerRemaining=0,preWinnerTarget=0,preWinnerCloseStage=0,preWinnerFlow=0;
 if(role==='admin'&&sim){
  const nextRank=sim.finish.length+1,upcoming=winningTargetRanks().filter(r=>r>=nextRank).sort((a,b)=>a-b);
  preWinnerTarget=upcoming[0]||0;preWinnerRemaining=preWinnerTarget?preWinnerTarget-nextRank:0;
  const preWinnerLimit=10;
  preWinnerFocus=preWinnerTarget>0&&preWinnerRemaining>=0&&preWinnerRemaining<=preWinnerLimit;
  // 당첨 촬영 구간이 시작돼도 카메라가 결승 입구로 먼저 순간이동하지 않는다.
  // 실제 선두 공 무리가 중·하단으로 내려오는 진행도에 맞춰 결승 프레임 비중을 서서히 높인다.
  const frontY=ys.length?q(.88):0,gateY=map.finalZone?.gateY??mh-420,zoneTop=map.finalZone?.top??gateY-620;
  const flowStart=Math.max(120,zoneTop-900),flowEnd=Math.max(flowStart+220,gateY-220);
  preWinnerFlow=preWinnerFocus?clamp((frontY-flowStart)/Math.max(1,flowEnd-flowStart),0,1):0;
  // 예: 32번째 당첨이면 26번째 공이 들어간 직후부터(남은 5개) 본격적인 촬영 준비에 들어간다.
  preWinnerCloseStage=preWinnerFocus?clamp((6-preWinnerRemaining)/6,0,1):0;
  if(preWinnerFocus&&sim.preWinnerFocusRank!==preWinnerTarget){sim.preWinnerFocusRank=preWinnerTarget;sim.preWinnerFocusStartedAt=nowCam;sim.cameraHoldUntil=0}
  if(!preWinnerFocus&&preWinnerTarget!==sim.preWinnerFocusRank&&preWinnerRemaining>10){sim.preWinnerFocusRank=0;sim.preWinnerFocusStartedAt=0}
 }
 // 목표 구간은 충분히 오래 유지하고, 다음 목표가 멀 때도 한 단계씩만 내려간다.
 if(role==='admin'&&sim&&nowCam>=sim.cameraHoldUntil){
  if(performance.now()<(sim.winnerReturnUntil||0)){
   sim.cameraTargetY=clamp(Number(sim.winnerReturnY)||0,0,Math.max(0,mh-h+40));
   sim.cameraTargetX=W/2;sim.cameraTargetZoom=.90;sim.cameraReason='당첨 확정 후 메인 화면 복귀';sim.cameraHoldUntil=nowCam+80;
  }
  else if(startTopCamera){sim.cameraTargetY=0;sim.cameraReason='출발 공 대기·동시 낙하';sim.cameraHoldUntil=nowCam+80}
  else if(startFlowCamera){
   const flowFront=ys.length?q(.82):0;
   const flowViewH=h/Math.max(.01,renderBaseScale*.96);
   const flowTarget=clamp(flowFront-flowViewH*.34,0,Math.max(0,mh-flowViewH+40));
   sim.cameraTargetY=flowTarget;sim.cameraReason='시작 공 낙하 흐름 추적';sim.cameraHoldUntil=nowCam+55;
  }
  else for(const stop0 of stops){const sy=typeof stop0==='number'?stop0:stop0.y,weight=typeof stop0==='number'?1:(stop0.weight||1);const band=active.filter(b=>Math.abs(b.y-sy)<230),around=band.length;if(!around)continue;const xs0=band.map(b=>b.x),spread0=xs0.length>1?Math.max(...xs0)-Math.min(...xs0):0;const density=around/Math.max(1,active.length);const proximity=Math.max(0,1-Math.abs(focusY-sy)/780);const score=(density*8.2+Math.min(1.5,spread0/300)+proximity*1.7)*weight;if(score>bestScore){bestStop=sy;bestScore=score}}
  const finishNow=q(.76)>mh-820;
  let nextTarget;
  if(winnerCinematic){
   const gateY0=map.finalZone?.gateY??mh-420,entryY0=map.finalZone?.cleanDropTop??gateY0,finishY0=map.finishY??mh-16;
   const entryApproachTop=Math.max(map.finalZone?.top??entryY0-850,entryY0-900);
   const entryP=clamp((focusWinnerBall.y-entryApproachTop)/Math.max(1,entryY0-entryApproachTop),0,1);
   const greedFixed=map.type==='greed';
   const liveZoom=greedFixed?(1.18+entryP*.18):(2.02+Math.sin(Math.PI*entryP)*.30-entryP*.05);
   const liveViewH=h/Math.max(.01,renderBaseScale*liveZoom);
   // 욕망의 항아리는 중앙의 실제 입구를 결승 지점으로 본다.
   // 당첨공이 입구 위쪽 길을 내려오는 동안만 따라가고, 입구에 도달하면 카메라는 그 자리에서 멈춘다.
   if(greedFixed){
    // 당첨공이 입구에 들어간 뒤에도 공을 화면 중앙보다 살짝 위에 두고
    // 실제 하단 낙하 경로를 끝까지 부드럽게 따라간다.
    nextTarget=clamp(focusWinnerBall.y-liveViewH*.46,0,Math.max(0,mh-liveViewH+40));
   }else nextTarget=clamp(focusWinnerBall.y-liveViewH*.46,0,Math.max(0,mh-liveViewH+40));
   sim.cameraReason=greedFixed?(entryP<.72?'당첨 공 입구 접근 경로 추적':'중앙 입구 당첨 확인'):(entryP<.08?'당첨 공 입구 통과':entryP<.78?'당첨 공 낙하 추적':'당첨 공 결승 추적');sim.cameraHoldUntil=nowCam+55
  }
  else if(preWinnerFocus){
   const isGreed=map.type==='greed',close=clamp((10-preWinnerRemaining)/10,0,1),shot=preWinnerCloseStage;
   // 10개 전에는 결승 구간으로 천천히 이동하고, 6개 전부터는 입구를 중심으로 단계적으로 클로즈업한다.
   const countSettle=clamp((10-preWinnerRemaining)/4,0,1);
   const settle=countSettle*preWinnerFlow;
   const lockedZoom=1.02+close*.20+shot*.52;
   const preZoom=(.90+(lockedZoom-.90)*preWinnerFlow);
   const greedPreZoom=isGreed?(1.00+preWinnerFlow*(.18+shot*.16)):preZoom;
   const preViewH=h/Math.max(.01,renderBaseScale*greedPreZoom),gateY0=map.finalZone?.gateY??mh-420,entryY0=map.finalZone?.cleanDropTop??gateY0,topY0=map.finalZone?.top??gateY0-520,finishY0=map.finishY??mh-16;
   const lockedCenter=isGreed?entryY0:(gateY0+Math.min(150,Math.max(55,(finishY0-gateY0)*(.10+close*.06))));
   const candidateCenter=isGreed&&greedCameraCandidate?clamp(greedCameraCandidate.y,entryY0-900,entryY0):focusY;
   const roamingCenter=isGreed?candidateCenter:focusY;
   const frameCenter=roamingCenter+(lockedCenter-roamingCenter)*settle;
   const anchor=isGreed?.38:(.48-shot*.10);
   nextTarget=clamp(frameCenter-preViewH*anchor,0,Math.max(0,mh-preViewH+40));
   sim.cameraReason=isGreed?(shot>.02?'욕망의 항아리 중앙 입구 당첨 준비':'욕망의 항아리 입구 접근 흐름'):(shot>.02?'당첨 6개 전 클로즈업 준비':'당첨 10개 전 결승 구간 이동');sim.cameraHoldUntil=nowCam+65
  }
  else if(bottomCameraLocked){nextTarget=bottomFixedCam;sim.cameraReason='하단 고정';sim.cameraHoldUntil=nowCam+900}
  else if(finishNow){nextTarget=clamp((map.finalZone?.gateY||mh-420)-h*.51,0,mh-h+40);sim.cameraReason='결승';sim.cameraHoldUntil=nowCam+760}
  else{
   // 목표 당첨 순번까지 남은 흐름에 맞춰 상단·중간 지형·하단 포인트를 유연하게 오간다.
   // 예: 목표 55번이면 30번대까지는 중간 장애물과 하단을 번갈아 보여주고, 이후 점점 결승 쪽 비중을 높인다.
   const tourCandidates=[];
   for(const stop0 of stops){
    const sy=typeof stop0==='number'?stop0:stop0.y;
    const band=active.filter(b=>Math.abs(b.y-sy)<280);
    if(!band.length)continue;
    const spread=band.length>1?Math.max(...band.map(b=>b.x))-Math.min(...band.map(b=>b.x)):0;
    const activity=band.length+Math.min(6,spread/90);
    if(activity>=1.8)tourCandidates.push({y:sy,activity});
   }
   const upperY=q(.24),midY=q(.48),lowerY=q(.68),deepY=map.finalZone?Math.max(q(.76),map.finalZone.top-240):q(.78);
   const fallbackStops=[upperY,midY,lowerY,deepY].filter(Number.isFinite).map((y,i)=>({y,activity:1,kind:i}));
   const rawPoints=(tourCandidates.length?tourCandidates:fallbackStops).sort((a,b)=>a.y-b.y);
   const upper=rawPoints.filter(v=>v.y<=q(.42));
   const middle=rawPoints.filter(v=>v.y>q(.32)&&v.y<=q(.70));
   const lower=rawPoints.filter(v=>v.y>q(.58));
   let points;
   if(cameraTargetRank&&cameraProgress<.35)points=[...middle,...lower,...upper.slice(-1)];
   else if(cameraTargetRank&&cameraProgress<.70)points=[...lower,...middle,...upper.slice(-1)];
   else points=[...lower,...middle.slice(-2)];
   if(!points.length)points=rawPoints;
   // 같은 위치 중복 제거.
   points=points.filter((v,i,a)=>a.findIndex(z=>Math.abs(z.y-v.y)<80)===i);
   if(!Number.isFinite(sim.cameraTourIndex))sim.cameraTourIndex=0;
   if(!sim.cameraTourChangedAt)sim.cameraTourChangedAt=nowCam;
   const tourInterval=map.type==='greed'?3300:(cameraProgress<.35?3000:cameraProgress<.70?2700:2350);
   if(nowCam-sim.cameraTourChangedAt>tourInterval&&points.length>1){sim.cameraTourIndex=(sim.cameraTourIndex+1)%points.length;sim.cameraTourChangedAt=nowCam}
   const picked=points.length?points[sim.cameraTourIndex%points.length]:null;
   if(map.type==='greed'){
    // 욕망의 항아리 전용 프리셋: 빈 상단·빈 바닥을 피하고 실제 공 흐름과 항아리 구조를 함께 보여준다.
    // 선두 공의 진행도에 따라 상단 분기 → 항아리 몸통 → 중앙 입구 순으로만 천천히 이동한다.
    const gateY0=map.finalZone?.gateY??mh-420,entryY0=map.finalZone?.cleanDropTop??gateY0,zoneTop0=map.finalZone?.top??gateY0-650;
    const frontY=ys.length?q(.86):zoneTop0,bodyY=clamp(q(.58),zoneTop0-760,entryY0-300);
    const phase=clamp((frontY-(zoneTop0-1050))/Math.max(1,(entryY0-150)-(zoneTop0-1050)),0,1);
    const upperCenter=clamp(q(.40),zoneTop0-980,zoneTop0-360);
    const bodyCenter=clamp(bodyY,zoneTop0-520,entryY0-300);
    const entryCenter=entryY0;
    let greedCenter;
    if(greedCameraCandidate){
     // 후보 공과 입구를 한 화면에 유지한다. 후보가 입구에 가까워질수록 입구 고정 비중이 커진다.
     const candidateP=clamp((greedCameraCandidate.y-(entryY0-1350))/1350,0,1);
     const candidateCenter=clamp(greedCameraCandidate.y,zoneTop0-820,entryY0);
     greedCenter=candidateCenter+(entryCenter-candidateCenter)*(.38+candidateP*.42);
    }else if(phase<.34)greedCenter=upperCenter+(bodyCenter-upperCenter)*(phase/.34);
    else if(phase<.82)greedCenter=bodyCenter+(entryCenter-bodyCenter)*((phase-.34)/.48);
    else greedCenter=entryCenter;
    const greedZoom=.90+(greedCameraCandidate?.10:(phase>.72?.04:0)),greedViewH=h/Math.max(.01,renderBaseScale*greedZoom);
    nextTarget=clamp(greedCenter-greedViewH*.40,0,Math.max(0,mh-greedViewH+40));
    sim.cameraReason=greedCameraCandidate?'입구 유력 후보 공 추적':(phase<.34?'항아리 상단 분기 흐름':phase<.82?'항아리 몸통 공 흐름':'중앙 입구 경쟁');
    sim.cameraHoldUntil=nowCam+900;
   }else if(picked){
    const progressBias=cameraTargetRank?cameraProgress:0;
    const frameAnchor=.43-progressBias*.025;
    nextTarget=clamp(picked.y-h*frameAnchor,0,mh-h+40);
    sim.cameraReason=progressBias<.35?'초반 지형 포인트':progressBias<.70?'중반 지형·하단 순회':'후반 결승 접근 순회';
    sim.cameraHoldUntil=nowCam+620;
   }else if(bestStop!==null&&bestScore>1.2){
    nextTarget=clamp(bestStop-h*.43,0,mh-h+40);sim.cameraReason='장애물';sim.cameraHoldUntil=nowCam+420;
   }else{
    nextTarget=clamp(focusY-h*.43,0,mh-h+40);sim.cameraReason='선두권';sim.cameraHoldUntil=nowCam+420;
   }
  }
  // 욕망의 항아리 REMIX는 경기 중간에 카메라가 결승 통로 아래로 과도하게 내려가지 않게 한다.
  // 하단 공 무리는 보이되, 세로 배출 통로 끝이나 빈 바닥까지 쫓아가지 않는다.
  if(map.type==='greed'&&!winnerCinematic){
   const entryY0=map.finalZone?.cleanDropTop??map.finalZone?.gateY??mh-420;
   const greedMidViewH=h/Math.max(.01,renderBaseScale*(sim?.camZoom||.90));
   const greedMidCap=greedEntryAnchorCam(map,greedMidViewH,mh);
   nextTarget=Math.min(nextTarget,greedMidCap);
  }
  // 한 번의 목표 변경 폭을 제한해 카메라가 위아래로 출렁이지 않게 한다.
  const maxJump=map.type==='greed'?h*.42:h*.62;sim.cameraTargetY=clamp(sim.cam+clamp(nextTarget-sim.cam,-maxJump,maxJump),0,mh-h+40);sim.cameraLastPick=nowCam;
 }
 if(role==='admin'&&sim&&manualCam===null&&Number.isFinite(sim.cameraTargetY))targetCam=sim.cameraTargetY;
 if(role==='admin'&&sim&&winnerCinematic){
  const gateY0=map.finalZone?.gateY??mh-420,entryY0=map.finalZone?.cleanDropTop??gateY0,approachTop=Math.max(map.finalZone?.top??entryY0-850,entryY0-900),entryP=clamp((focusWinnerBall.y-approachTop)/Math.max(1,entryY0-approachTop),0,1);
  const greedFixed=map.type==='greed';
  const liveZoom=greedFixed?(1.18+entryP*.18):(3.05+Math.sin(Math.PI*entryP)*.38-entryP*.10),liveViewH=h/Math.max(.01,renderBaseScale*liveZoom);
  if(greedFixed){
   targetCam=clamp(focusWinnerBall.y-liveViewH*.50,0,Math.max(0,mh-liveViewH+40));
  }else targetCam=clamp(focusWinnerBall.y-liveViewH*.50,0,Math.max(0,mh-liveViewH+40));
 }
 else if(role==='admin'&&sim&&preWinnerFocus){
  const isGreed=map.type==='greed',close=clamp((10-preWinnerRemaining)/10,0,1),shot=preWinnerCloseStage,countSettle=clamp((10-preWinnerRemaining)/4,0,1),settle=countSettle*preWinnerFlow,lockedZoom=1.02+close*.20+shot*.52,preZoom=.90+(lockedZoom-.90)*preWinnerFlow,preViewH=h/Math.max(.01,renderBaseScale*preZoom),gateY0=map.finalZone?.gateY??mh-420,topY0=map.finalZone?.top??gateY0-520,finishY0=map.finishY??mh-16;
  if(isGreed){
   // 하단 고정 없이 유력 후보와 선두 공 흐름을 따라간다.
   const liveY=greedCameraCandidate?.y??focusY;
   targetCam=clamp(liveY-preViewH*.44,0,Math.max(0,mh-preViewH+40));
  }else{
   const lockedCenter=gateY0+Math.min(150,Math.max(55,(finishY0-gateY0)*(.10+close*.06)));
   const frameCenter=focusY+(lockedCenter-focusY)*settle;
   const anchor=.48-shot*.10;
   targetCam=clamp(frameCenter-preViewH*anchor,0,Math.max(0,mh-preViewH+40));
  }
 }
 else if(role==='admin'&&sim&&bottomCameraLocked)targetCam=bottomFixedCam;
 else if(role==='admin'&&sim&&performance.now()<(sim.winnerReturnUntil||0))targetCam=clamp(Number(sim.winnerReturnY)||0,0,Math.max(0,mh-h+40));
 else if(role==='admin'&&sim&&(nearFinish||performance.now()<sim.finishFocusUntil))targetCam=clamp((map.finalZone?.gateY||mh-420)-h*.51,0,mh-h+40);
 if(startTopCamera)targetCam=0;
 if(startFlowCamera){
  const flowFront=ys.length?q(.82):0;
  const flowViewH=h/Math.max(.01,renderBaseScale*.96);
  targetCam=clamp(flowFront-flowViewH*.34,0,Math.max(0,mh-flowViewH+40));
 }
 // v15.10av: 하단에 계속 고정하지는 않지만, 마지막 경쟁 구간을 보여줄 때는
 // 사용자가 직접 지정한 정확한 좌표(X=566.25, Y=2900.99, Zoom=.9459)를 유지한다.
 // 후반에는 결승/중앙/좌측 날개/결승/우측 날개를 5초 간격으로 순회하고,
 // 실제 당첨공 연출이 시작되면 프리셋을 해제해 당첨공을 자연스럽게 추적한다.
 let greedPreset=null;
 if(role==='admin'&&sim&&map.type==='greed'&&manualCam===null&&!startTopCamera&&!startFlowCamera&&!winnerCinematic){
  const greedEntryY0=map.finalZone?.cleanDropTop??map.finalZone?.gateY??mh-420;
  const flowReachedCompetition=active.some(b=>!b.done&&Number.isFinite(b.y)&&b.y>=greedEntryY0-760);
  const lateCompetition=(cameraTargetRank?cameraProgress>=.58:false)||flowReachedCompetition||nearFinish||preWinnerFocus||performance.now()<(sim.finishFocusUntil||0);
  if(!lateCompetition)sim.greedFixedCameraStartedAt=0;
  greedPreset=greedCameraPreset(nowCam,sim,false,lateCompetition);
  if(greedPreset){targetCam=greedPreset.y;sim.cameraReason=greedPreset.reason}
 }
 const visibleBand=active.filter(b=>b.y>targetCam-150&&b.y<targetCam+h+150).sort((a,b)=>a.x-b.x);
 const finalContenders=preWinnerFocus&&map.finalZone?active.filter(b=>b.y>map.finalZone.gateY-520&&b.y<map.finalZone.gateY+260):[];
 const bottomContenders=bottomCameraLocked&&map.finalZone?active.filter(b=>b.y>map.finalZone.top-160):[];
 const prepContenders=preWinnerFocus&&map.finalZone?active.filter(b=>b.y>map.finalZone.gateY-650&&b.y<map.finalZone.gateY+120):[];
 const prepCenterX=median(prepContenders.length?prepContenders:(finalContenders.length?finalContenders:visibleBand),'x',map.finishX||W/2);
 const autoLeadX=median(visibleBand.length?visibleBand:leadGroup,'x',W/2);
 const stableGreedBand=map.type==='greed'?active.filter(b=>b.y>targetCam-260&&b.y<targetCam+h+260):[];
 const stableGreedX=median(stableGreedBand.length?stableGreedBand:visibleBand,'x',map.finishX||W/2);
 const preWinnerX=autoLeadX+(((map.finishX||W/2)+(prepCenterX-(map.finishX||W/2))*(1-preWinnerCloseStage*.75))-autoLeadX)*preWinnerFlow;
 const greedEntryY=map.finalZone?.cleanDropTop??map.finalZone?.gateY??mh-420;
 const greedWinnerPathP=winnerCinematic&&map.type==='greed'?clamp((focusWinnerBall.y-(greedEntryY-900))/900,0,1):0;
 const greedWinnerX=winnerCinematic&&map.type==='greed'?(focusWinnerBall.x+((map.finishX||W/2)-focusWinnerBall.x)*(.20+.70*greedWinnerPathP)):(map.finishX||W/2);
 let targetX=startTopCamera?W/2:(startFlowCamera?median(leadGroup,'x',W/2):(winnerCinematic?focusWinnerBall.x:(bottomCameraLocked?(map.finishX||W/2):(preWinnerFocus?(map.type==='greed'?(greedCameraCandidate?.x??stableGreedX):preWinnerX):(map.type==='greed'?(greedCameraCandidate?.x??stableGreedX):autoLeadX)))));
 const spreadX=visibleBand.length?Math.max(...visibleBand.map(b=>b.x))-Math.min(...visibleBand.map(b=>b.x)):0;
 const spreadY=ys.length?q(.86)-q(.18):0;let desiredZoom=startTopCamera?1.0:(startFlowCamera?.96:((spreadX>500||spreadY>h*.88)?.84:.90));
 // 당첨 10개 전부터 결승 입구를 크게 고정하고, 실제 당첨 직전에는 후보 공 자체를 더 크게 추적한다.
 if(winnerCinematic){
  const gateY0=map.finalZone?.gateY??mh-420,finishY0=map.finishY??mh-16,dropSpan=Math.max(140,finishY0-gateY0),dropP=clamp((focusWinnerBall.y-gateY0)/dropSpan,0,1);
  // 욕망의 항아리는 예시처럼 하단 전체를 편하게 볼 수 있도록 고정 배율,
  // 다른 맵은 기존의 당첨 공 원샷 클로즈업을 유지한다.
  desiredZoom=map.type==='greed'?(1.18+clamp((focusWinnerBall.y-((map.finalZone?.cleanDropTop??gateY0)-900))/900,0,1)*.18):(3.05+Math.sin(Math.PI*dropP)*.38-dropP*.10);
 }
 else if(preWinnerFocus){
  if(map.type==='greed')desiredZoom=.94;
  else{const close=clamp((10-preWinnerRemaining)/10,0,1),shot=preWinnerCloseStage,lockedZoom=1.02+close*.20+shot*.52;desiredZoom=.90+(lockedZoom-.90)*preWinnerFlow}
 }
 else if(bottomCameraLocked)desiredZoom=.94;
 // 결승에서도 지나치게 확대하지 않고 사다리꼴 전체와 주변 공을 함께 보여준다.
 else if(nearFinish)desiredZoom=.94;
 if(greedPreset){targetX=greedPreset.x;desiredZoom=greedPreset.zoom}
 // v15.10bq: 빨리감기 중에는 경기 시간만 가속하고 카메라 연출 타이머/순회는 가속하지 않는다.
 // 현재 살아 있는 공 무리를 안정적으로 프레임 안에 유지해 화면이 빈 곳이나 맵 바깥으로 튀는 현상을 차단한다.
 if(role==='admin'&&sim&&canvasDragFastForward&&manualCam===null&&!winnerCinematic){
  // 배속 중에도 기존 자동 카메라 목표를 유지한다. 공 좌표 기반 재계산으로 화면이 튀는 것을 금지한다.
  sim.cameraReason='5배속 · 기존 카메라 유지';
 }
 // v15.10bt: 배속 중 공 좌표 이상치가 생겨도 카메라가 맵 밖으로 끌려가지 않도록
 // 목표 줌과 X/Y 목표를 실제 보이는 월드 범위 안으로 먼저 제한한다.
 desiredZoom=clamp(Number(desiredZoom)||.90,.78,1.42);
 {
  const safeS=Math.max(.01,renderBaseScale*desiredZoom);
  const viewWorldW=w/safeS,viewWorldH=h/safeS;
  const halfViewW=viewWorldW*.5;
  targetX=viewWorldW>=W?W/2:clamp(Number(targetX)||W/2,halfViewW,W-halfViewW);
  targetCam=clamp(Number(targetCam)||0,0,Math.max(0,mh-viewWorldH));
 }
 if(role==='admin'&&sim&&manualCam!==null){targetCam=clamp(manualCam,0,mh-h+40);sim.cam+=(targetCam-sim.cam)*.105}
 else if(role==='admin'&&sim){
  // 시간 기반 지수 보간으로 FPS가 달라도 같은 속도로 부드럽게 이동한다.
  const frameDt=Math.min(40,Math.max(4,ts-(sim.cameraFrameTs||ts-16)));sim.cameraFrameTs=ts;
  const preGreed=false;
  const prepFast=preWinnerFocus&&preWinnerCloseStage>0;
  // 기본 카메라는 느리고 안정적으로, 당첨 연출에서만 조금 빠르게 반응한다.
  const calmGreed=map.type==='greed'&&!winnerCinematic;
  const yEase=1-Math.exp(-frameDt/(winnerCinematic?78:(calmGreed?330:(bottomCameraLocked?230:(preWinnerFocus?(prepFast?175:260):245))))),xEase=1-Math.exp(-frameDt/(winnerCinematic?88:(calmGreed?390:(bottomCameraLocked?270:(preWinnerFocus?(prepFast?195:300):290))))),zEase=1-Math.exp(-frameDt/(winnerCinematic?105:(calmGreed?450:(bottomCameraLocked?330:(preWinnerFocus?(prepFast?220:360):380)))));
  sim.cam+=(targetCam-sim.cam)*yEase;sim.camX+=(targetX-sim.camX)*xEase;sim.camZoom+=(desiredZoom-sim.camZoom)*zEase;
  // 보간 도중에도 매 프레임 강제 안전 범위를 적용한다. 배속을 오래 누르고 있어도
  // 핀볼 맵의 네온 외곽과 캔버스가 화면 밖으로 사라지지 않는다.
  sim.camZoom=clamp(Number(sim.camZoom)||.90,.78,1.42);
  const liveS=Math.max(.01,renderBaseScale*sim.camZoom),liveViewW=w/liveS,liveViewH=h/liveS;
  sim.camX=liveViewW>=W?W/2:clamp(Number(sim.camX)||W/2,liveViewW*.5,W-liveViewW*.5);
  sim.cam=clamp(Number(sim.cam)||0,0,Math.max(0,mh-liveViewH));
 }else{targetCam=state?.snapshot?.cam||targetCam}
 const cam=role==='admin'&&sim?sim.cam:targetCam,camX=role==='admin'&&sim?sim.camX:Number(state?.snapshot?.camX||W/2);let zoom=role==='admin'&&sim?sim.camZoom:Number(state?.snapshot?.camZoom||desiredZoom);
 if(role==='admin'&&sim&&winnerCinematic){const zp=clamp((performance.now()-sim.finishZoomStart)/(sim.firstWinnerPreview?260:420),0,1);const ez=zp*zp*(3-2*zp);zoom+=ez*(sim.firstWinnerPreview?.05:.07)}
 const baseScale=renderBaseScale,sx=baseScale*zoom,viewCenter=w/2,ox=viewCenter-camX*sx;
 x.save();x.translate(ox,-cam*sx);x.scale(sx,sx);drawMap(x,map,theme);map.rot.forEach((r,i)=>{const a=role==='admin'&&sim?r.a:(state?.snapshot?.rot?.[i]||0),co=Math.cos(a),si=Math.sin(a);x.strokeStyle=theme.line;x.shadowColor=theme.glow;x.shadowBlur=18;x.lineWidth=16;x.beginPath();x.moveTo(r.x-co*r.len/2,r.y-si*r.len/2);x.lineTo(r.x+co*r.len/2,r.y+si*r.len/2);x.stroke();x.shadowBlur=0});if(map.gate){const a=role==='admin'&&sim?map.gate.a:Number(state?.snapshot?.gate||0),co=Math.cos(a),si=Math.sin(a),half=map.gate.len/2;x.save();x.strokeStyle=theme.line;x.shadowColor=theme.glow;x.shadowBlur=22;x.lineWidth=18;x.lineCap='round';x.beginPath();x.moveTo(map.gate.pivotX-co*half,map.gate.pivotY-si*half);x.lineTo(map.gate.pivotX+co*half,map.gate.pivotY+si*half);x.stroke();x.fillStyle='#fff';x.beginPath();x.arc(map.gate.pivotX,map.gate.pivotY,11,0,Math.PI*2);x.fill();x.restore()}
 // 원본 SkillEffect: 0.5초 동안 반경 10 월드 단위로 퍼지는 원형 충격파.
 for(const b of source){if(b.done)continue;const alpha=(role==='admin'&&sim)?clamp(sim.acc/8.333,0,1):1,rx=(role==='admin'&&sim&&Number.isFinite(b.prevX))?b.prevX+(b.x-b.prevX)*alpha:b.x,ry=(role==='admin'&&sim&&Number.isFinite(b.prevY))?b.prevY+(b.y-b.prevY)*alpha:b.y;const hideAtWinnerEnd=!!(role==='admin'&&sim?.winnerResolved&&String(sim.focusBallId)===String(b.ballId)&&Number.isFinite(Number(b.winnerHideAt))&&performance.now()>=Number(b.winnerHideAt));if(hideAtWinnerEnd)continue;const focusStillLive=!!(role==='admin'&&sim?.focusBallId&&String(sim.focusBallId)===String(b.ballId)&&(performance.now()<sim.finishZoomUntil||(sim.winnerResolved&&b.qualified&&!b.done))),isFocusBall=focusStillLive,cinematicActive=!!(role==='admin'&&sim?.focusBallId&&(performance.now()<sim.finishZoomUntil||(sim.winnerResolved&&focusWinnerBall&&!focusWinnerBall.done)));x.save();if(cinematicActive&&!isFocusBall)x.globalAlpha=.18;const pulse=isFocusBall?(1.48+Math.sin(performance.now()*.010)*.08):1,visualR=(b.r||R)*pulse;const hue=getNameHue(b.name),impactMs=role==='admin'&&sim?Math.max(0,Number(b.impactUntil||0)-performance.now()):Math.max(0,Number(b.impactMs||0)),impactLight=70+25*Math.min(1,impactMs/500);x.shadowColor=getNameColor(b.name,.95);x.shadowBlur=isFocusBall?22:(denseMode?0:10);x.fillStyle=`hsl(${hue} 86% ${Math.min(86,impactLight)}%)`;x.beginPath();x.arc(rx,ry,visualR,0,7);x.fill();x.lineWidth=isFocusBall?3:2;x.strokeStyle='#fff';x.stroke();x.shadowBlur=0;
  if(room==='GROUP'){const mark=String(b.ownerInitial||ownerMark(b.owner)||'').slice(0,1);if(mark){x.textAlign='center';x.textBaseline='middle';x.font=`1000 ${Math.max(11,Math.round(visualR*1.05))}px Pretendard, Arial, sans-serif`;x.lineWidth=2.5;x.strokeStyle='rgba(0,0,0,.78)';x.strokeText(mark,rx,ry+1);x.fillStyle='#fff';x.fillText(mark,rx,ry+1)}}
  // v11.6: 공 안쪽 글씨는 제거하고 바깥 테두리 아래에만 이름을 또렷하게 표시한다.
  if(!denseMode){
   const ballLabel=String(b.name||'').slice(0,8);
   x.textAlign='center';x.textBaseline='middle';x.lineJoin='round';
   x.font='900 15px Pretendard, "Noto Sans KR", Arial, sans-serif';
   x.lineWidth=3.5;x.strokeStyle='rgba(0,0,0,.88)';x.strokeText(ballLabel,rx,ry+visualR+15);
   x.fillStyle=getNameColor(b.name,1);x.fillText(ballLabel,rx,ry+visualR+15);
  }
 const skillCoolMs=role==='admin'&&sim?Math.max(0,Number(b.skillCoolTime)||0):Math.max(0,Number(b.skillCoolMs||0)),skillMaxMs=role==='admin'&&sim?(Number(b.skillMaxCoolTime)||1000):(Number(b.skillMaxCoolMs)||1000);
 if(!denseMode&&skillCoolMs>0){const start=-Math.PI/2,end=start+Math.PI*2*(skillCoolMs/Math.max(1,skillMaxMs));x.save();x.strokeStyle='rgba(255,255,255,.72)';x.lineWidth=1.5;x.beginPath();x.arc(rx,ry,(b.r||R)+3,start,end);x.stroke();x.restore()}
 const stunMs=role==='admin'&&sim?Math.max(0,b.stunUntil-performance.now()):Math.max(0,Number(b.stunMs||0));
 if(stunMs>0){
  const total=1800,remain=clamp(stunMs/total,0,1),start=-Math.PI/2,end=start+Math.PI*2*(1-remain);
  x.save();x.lineWidth=4;x.strokeStyle='rgba(255,255,255,.28)';x.beginPath();x.arc(rx,ry,R+7,0,Math.PI*2);x.stroke();
  x.lineWidth=5;x.lineCap='round';x.strokeStyle='#fff7a8';x.shadowColor='#fff2a0';x.shadowBlur=14;x.beginPath();x.arc(rx,ry,(b.r||R)+7,start,end);x.stroke();
  x.fillStyle='#fff';x.font='900 10px Arial';x.textAlign='center';x.fillText((stunMs/1000).toFixed(1),rx,ry+3);x.restore();
 }
 x.restore();
 }x.restore();
 // 첫 번째 당첨 후보는 결승 진입 직전에도 다른 공 위에 한 번 더 그려 겹침 없이 식별되게 한다.
 if(role==='admin'&&sim?.firstWinnerPreview&&focusWinnerBall&&performance.now()<sim.finishZoomUntil){
  const a=clamp(sim.acc/8.333,0,1),wx=focusWinnerBall.prevX+(focusWinnerBall.x-focusWinnerBall.prevX)*a,wy=focusWinnerBall.prevY+(focusWinnerBall.y-focusWinnerBall.prevY)*a;
  const px=ox+wx*sx,py=(wy-cam)*sx,rr=(focusWinnerBall.r||R)*sx*2.05;
  x.save();x.textAlign='center';x.textBaseline='middle';x.shadowColor=getNameColor(focusWinnerBall.name,.98);x.shadowBlur=34;
  x.fillStyle=getNameColor(focusWinnerBall.name,1);x.beginPath();x.arc(px,py,rr,0,Math.PI*2);x.fill();x.lineWidth=4;x.strokeStyle='#fff';x.stroke();x.shadowBlur=0;
  x.font='1000 28px Pretendard, "Noto Sans KR", Arial, sans-serif';x.lineWidth=5;x.strokeStyle='rgba(0,0,0,.90)';x.strokeText(String(focusWinnerBall.name||'').slice(0,10),px,py+rr+25);x.fillStyle='#fff';x.fillText(String(focusWinnerBall.name||'').slice(0,10),px,py+rr+25);x.restore();
 }
 if(role==='admin'&&sim?.finishFlash&&performance.now()>=sim.finishFlash.startAt&&performance.now()<sim.finishFlash.until){
  const f=sim.finishFlash,nowFx=performance.now();
  const liveWinner=source.find(q=>String(q.ballId)===String(f.ballId))||f;
  const alpha=(role==='admin'&&sim)?clamp(sim.acc/8.333,0,1):1;
  const wx=(Number.isFinite(liveWinner.prevX)?liveWinner.prevX+(liveWinner.x-liveWinner.prevX)*alpha:liveWinner.x);
  const wy=(Number.isFinite(liveWinner.prevY)?liveWinner.prevY+(liveWinner.y-liveWinner.prevY)*alpha:liveWinner.y);
  const px=ox+wx*sx,py=(wy-cam)*sx;
  const grow=clamp((nowFx-f.startAt)/Math.max(1,(f.peakAt||f.startAt+850)-f.startAt),0,1);
  const smooth=grow*grow*(3-2*grow);
  const fade=nowFx>(f.holdUntil||f.until-900)?clamp((f.until-nowFx)/Math.max(1,f.until-(f.holdUntil||f.until-900)),0,1):1;
  const rr=(b.r||R)*sx*(1+smooth*1.55);
  x.save();x.fillStyle=`rgba(3,6,18,${0.18+smooth*.34})`;x.fillRect(0,0,w,h);x.globalAlpha=fade;x.textAlign='center';x.textBaseline='middle';
  x.shadowColor=getNameColor(f.name,.98);x.shadowBlur=28+smooth*22;
  x.fillStyle=getNameColor(f.name,1);x.beginPath();x.arc(px,py,rr,0,Math.PI*2);x.fill();
  x.lineWidth=4;x.strokeStyle='#fff';x.stroke();x.shadowBlur=0;
  x.font=`1000 ${Math.round(18+smooth*14)}px Pretendard, "Noto Sans KR", Arial, sans-serif`;
  x.lineWidth=5;x.strokeStyle='rgba(0,0,0,.90)';x.strokeText(String(f.name||'').slice(0,10),px,py+rr+24);
  x.fillStyle='#fff';x.fillText(String(f.name||'').slice(0,10),px,py+rr+24);
  x.font='1000 34px Pretendard, Arial, sans-serif';x.lineWidth=8;x.strokeStyle='rgba(0,0,0,.92)';
  const msg=`🎉 당첨 · ${f.rank}번째 · ${f.name}${f.copy>1?' #'+f.copy:''}`;
  x.strokeText(msg,w/2,h*.18);x.fillStyle='#fff';x.fillText(msg,w/2,h*.18);x.restore();
 }
 const visibleWorldH=h/Math.max(.01,sx);
 drawMinimap(source,map,cam,visibleWorldH);renderRank()}
// v15.10ac: 다른 탭·창으로 이동해도 관리자 로컬 물리 레이스를 계속 진행한다.
// requestAnimationFrame이 백그라운드에서 느려져도 별도 물리 타이머가 실제 경과 시간을
// 작은 고정 스텝으로 보충하므로, 복귀 시 레이스가 초기화되거나 이전 상태로 되돌아가지 않는다.
let hiddenPhysicsLast=0;
function runBackgroundPhysics(){
 if(!document.hidden||role!=='admin'||!sim||!localRunning||sim.paused)return;
 const now=performance.now();
 if(!hiddenPhysicsLast){hiddenPhysicsLast=now;sim.last=now;return}
 let elapsed=Math.min(1200,Math.max(0,now-hiddenPhysicsLast));hiddenPhysicsLast=now;
 if(elapsed<=0)return;
 // 백그라운드에서도 물리 서브스텝만 가속하고 내부 타임스탬프를 강제로 당기지 않는다.
 sim.slowTarget=updateSlowMotion(now);
 sim.slowScale+=(sim.slowTarget-sim.slowScale)*(1-Math.exp(-elapsed/920));
 sim.slowScale=clamp(sim.slowScale,.14,1);
 const userSpeed=(canvasDragFastForward&&!(sim.focusBallId&&(now<sim.finishZoomUntil||(sim.winnerResolved&&sim.balls.some(b=>String(b.ballId)===String(sim.focusBallId)&&!b.done)))))?5:1;
 let budget=Math.min(420,elapsed*sim.slowScale*userSpeed);
 const physicsStep=8.333;
 let loops=0;
 while(budget>=physicsStep&&loops<50){step(physicsStep);budget-=physicsStep;loops++}
 sim.last=now;sim.lastStepAt=now;
 const snapshotGap=sim.balls.length>800?260:sim.balls.length>500?220:sim.balls.length>250?170:110;
 if(now-sim.lastSend>snapshotGap){sim.lastSend=now;sendSnapshot()}
}
setInterval(runBackgroundPhysics,200);
function handleVisibilityContinuity(){
 const now=performance.now();
 if(document.hidden){hiddenPhysicsLast=now;return}
 hiddenPhysicsLast=0;
 if(sim&&localRunning&&!sim.paused){sim.last=now;sim.lastStepAt=now;sim.acc=Math.min(sim.acc||0,8.332)}
 lastRemoteFrameTs=now;
}
document.addEventListener('visibilitychange',handleVisibilityContinuity,{passive:true});
window.addEventListener('pageshow',handleVisibilityContinuity,{passive:true});

function draw(ts){
 try{drawFrame(ts)}catch(err){
  const now=performance.now();
  if(now-lastRenderErrorAt>1200){lastRenderErrorAt=now;console.error('렌더 자동복구',err);if($('conn'))$('conn').textContent='화면 자동복구 중'}
  // 렌더 오류가 나도 맵이 영구적으로 사라지지 않도록 다음 프레임을 반드시 계속 실행한다.
  if(!state)state=makeLobbyState('wheel');
 }finally{requestAnimationFrame(draw)}
}
function drawMinimap(source,map,cam,viewWorldH){
 const c=$('minimapCanvas');if(!c)return;
 const d=Math.min(devicePixelRatio||1,(source?.length||0)>180?1:(source?.length||0)>90?1.25:1.5),w=c.clientWidth,h=c.clientHeight;
 if(c.width!==Math.round(w*d)||c.height!==Math.round(h*d)){c.width=Math.round(w*d);c.height=Math.round(h*d)}
 const x=c.getContext('2d');x.setTransform(d,0,0,d,0,0);x.clearRect(0,0,w,h);
 x.fillStyle='rgba(3,7,15,.92)';x.fillRect(0,0,w,h);
 const mh=map.worldH||H,pad=5,innerW=Math.max(1,w-pad*2),innerH=Math.max(1,h-pad*2),sy=innerH/mh,sx=innerW/W,scale=Math.min(sx,sy),theme=themes[state?.map||'wheel'];
 const mx=v=>pad+clamp(v,0,W)*sx,my=v=>pad+clamp(v,0,mh)*sy;
 x.save();x.beginPath();x.rect(pad,pad,innerW,innerH);x.clip();x.lineCap='round';
 x.strokeStyle=theme.line;x.globalAlpha=.48;x.lineWidth=Math.max(.8,3*scale);
 const miniWalls=map.s.filter(g=>g.miniMain||!map.s.some(q=>q.miniMain));
 for(const g of miniWalls){x.beginPath();x.moveTo(mx(g.x1),my(g.y1));x.lineTo(mx(g.x2),my(g.y2));x.stroke()}
 x.globalAlpha=.72;x.fillStyle=theme.peg;
 for(const q of map.p){x.beginPath();x.arc(mx(q.x),my(q.y),Math.max(1.1,q.r*scale),0,7);x.fill()}
 x.fillStyle=theme.bump;x.globalAlpha=.9;
 for(const q of map.bum){x.beginPath();x.arc(mx(q.x),my(q.y),Math.max(2,q.r*scale),0,7);x.fill()}
 for(const q of map.kick||[]){x.beginPath();x.arc(mx(q.x),my(q.y),Math.max(2,q.r*scale),0,7);x.fill()}
 x.strokeStyle=theme.line;x.globalAlpha=.95;x.lineWidth=Math.max(1.2,8*scale);
 for(let i=0;i<map.rot.length;i++){const r=map.rot[i],a=(role==='admin'&&sim)?r.a:(state?.snapshot?.rot?.[i]??r.a),co=Math.cos(a),si=Math.sin(a);x.beginPath();x.moveTo(mx(r.x-co*r.len/2),my(r.y-si*r.len/2));x.lineTo(mx(r.x+co*r.len/2),my(r.y+si*r.len/2));x.stroke()}
 if(map.gate){const a=(role==='admin'&&sim)?map.gate.a:Number(state?.snapshot?.gate||map.gate.a),co=Math.cos(a),si=Math.sin(a),half=map.gate.len/2;x.lineWidth=Math.max(1.4,10*scale);x.beginPath();x.moveTo(mx(map.gate.pivotX-co*half),my(map.gate.pivotY-si*half));x.lineTo(mx(map.gate.pivotX+co*half),my(map.gate.pivotY+si*half));x.stroke()}
 x.globalAlpha=1;
 const liveMini=source.filter(b=>!b.done),miniStep=Math.max(1,Math.ceil(liveMini.length/180));
 for(let bi=0;bi<liveMini.length;bi+=miniStep){const b=liveMini[bi];x.fillStyle=getNameColor(b.name,1);x.beginPath();x.arc(mx(b.x),my(b.y),Math.max(1.15,R*scale),0,7);x.fill()}
 x.strokeStyle='#ffed65';x.lineWidth=2;x.globalAlpha=.95;x.strokeRect(pad+1,clamp(my(cam),pad+1,pad+innerH-2),innerW-2,Math.max(8,Math.min(innerH-2,viewWorldH*sy)));
 x.restore();
 x.strokeStyle='rgba(255,255,255,.18)';x.lineWidth=1;x.strokeRect(pad+.5,pad+.5,innerW-1,innerH-1);
 if($('sectionLabel')){const n=cam/mh;$('sectionLabel').textContent=n<.18?'출발 구간':n<.4?'회전 장애물 구간':n<.65?'중반 역전 구간':n<.84?'마지막 경쟁 구간':'결승 벽타기 경쟁'}
}
let rankRenderAt=0,rankNodes=new Map(),rankStatusCache=new Map(),liveRankMemory=new Map();
let rankAutoScrollTarget=0,rankAutoScrollRaf=0,rankAutoScrollLast=0,rankAutoScrollLocked=false,rankAutoScrollRaceId=null;
let rankAutoScrollNextAt=0,rankAutoScrollLastFinished=-1,rankAutoScrollFirstHoldUntil=0;
function cancelRankAutoScroll(){
 rankAutoScrollLocked=true;
 if(rankAutoScrollRaf){cancelAnimationFrame(rankAutoScrollRaf);rankAutoScrollRaf=0}
 rankAutoScrollLast=0;
}
function bindRankManualScroll(el){
 if(!el||el.dataset.manualScrollBound==='1')return;
 el.dataset.manualScrollBound='1';
 const stop=()=>cancelRankAutoScroll();
 el.addEventListener('wheel',stop,{passive:true});
 el.addEventListener('touchstart',stop,{passive:true});
 el.addEventListener('pointerdown',stop,{passive:true});
}
function setRankAutoScroll(el,target){
 if(!el||rankAutoScrollLocked)return;
 const requested=clamp(target,0,Math.max(0,el.scrollHeight-el.clientHeight));
 // 진행 중 자동 스크롤은 항상 아래 방향으로만 움직인다.
 // 특히 '마지막' 모드에서 실시간 순위 재정렬 때문에 목록이 위로 튀는 현상을 차단한다.
 rankAutoScrollTarget=(state?.status==='running')?Math.max(el.scrollTop,rankAutoScrollTarget||0,requested):requested;
 if(rankAutoScrollRaf)return;
 const tick=(ts)=>{
  if(!el.isConnected){rankAutoScrollRaf=0;return}
  const dt=Math.min(34,Math.max(8,ts-(rankAutoScrollLast||ts)));rankAutoScrollLast=ts;
  const diff=rankAutoScrollTarget-el.scrollTop;
  if(Math.abs(diff)<.35){el.scrollTop=rankAutoScrollTarget;rankAutoScrollRaf=0;rankAutoScrollLast=0;return}
  // 체크된 이름을 눈으로 확인할 수 있도록 자동 스크롤을 느리고 부드럽게 이동한다.
  const ease=1-Math.exp(-dt/560);
  el.scrollTop+=diff*ease;
  rankAutoScrollRaf=requestAnimationFrame(tick);
 };
 rankAutoScrollRaf=requestAnimationFrame(tick);
}
function renderRank(force=false){
 if(!state)return;
 const now=performance.now();
 const rankBallCount=(role==='admin'&&sim?sim.balls.length:(state?.snapshot?.balls||[]).length);
 const rankGap=rankBallCount>500?650:rankBallCount>280?420:rankBallCount>160?280:140;
 if(!force&&now-rankRenderAt<rankGap)return;
 rankRenderAt=now;
 const finished=state.finishOrder||[],el=$('rankList');
 if(!el){if($('counter'))$('counter').textContent=finished.length+' / '+balls().length;return}
 bindRankManualScroll(el);
 el.style.overflowAnchor='none';
 const scrollTopBeforeRender=el.scrollTop;
 const currentRaceId=Number(state.raceId)||0;
 if(rankAutoScrollRaceId!==currentRaceId){rankAutoScrollRaceId=currentRaceId;rankAutoScrollLocked=false;if(rankAutoScrollRaf){cancelAnimationFrame(rankAutoScrollRaf);rankAutoScrollRaf=0}rankAutoScrollLast=0;rankAutoScrollNextAt=0;rankAutoScrollLastFinished=-1;rankAutoScrollFirstHoldUntil=0}
 let rows=[],title=el.parentElement?.querySelector('h3');
 const liveSource=role==='admin'&&sim?sim.balls:(state?.snapshot?.balls||[]);
 const hasLive=state.status==='running'&&liveSource.length>0;
 if(!hasLive){
  const lineup=orderedBalls();rows=lineup.map((b,i)=>({...b,rank:i+1,preview:true}));
  if(title)title.textContent=`전체 공 · 출발 순서 ${rows.length}`;
 }else{
  // v11.3: 오른쪽 목록은 결승 통로에 실제로 들어간 순서를 확정 순위로 위에서부터 쌓는다.
  // 아직 들어가지 않은 공은 현재 하강 진행도 순으로 그 뒤에 붙여 다음 진입 공을 쉽게 확인한다.
  const finishedMap=new Map(finished.map(b=>[String(b.ballId),b]));
  const liveRows=liveSource.filter(b=>!b.done&&!finishedMap.has(String(b.ballId))).map(b=>({...b,live:true}));
  liveRows.sort((a,b)=>{
   const aw=a.waiting?1:0,bw=b.waiting?1:0;if(aw!==bw)return aw-bw;
   const ay=Number(a.y)||0,by=Number(b.y)||0;if(Math.abs(by-ay)>.75)return by-ay;
   const avy=Number(a.vy)||0,bvy=Number(b.vy)||0;if(Math.abs(bvy-avy)>.025)return bvy-avy;
   const ap=liveRankMemory.get(String(a.ballId))??999999,bp=liveRankMemory.get(String(b.ballId))??999999;
   if(ap!==bp)return ap-bp;return String(a.ballId).localeCompare(String(b.ballId));
  });
  const doneRows=finished.map((b,i)=>({...b,rank:i+1,live:false,done:true}));
  rows=[...doneRows,...liveRows].map((b,i)=>({...b,rank:i+1}));
  liveRankMemory.clear();rows.forEach((b,i)=>liveRankMemory.set(String(b.ballId),i));
  if(title)title.textContent=`통과 현황 · ${finished.length} / ${balls().length}`;
 }
 const keep=new Set(),oldRankRects=new Map();
 const allowRankFlip=rows.length<=160;
 if(allowRankFlip)for(const [key,node] of rankNodes){if(node.isConnected)oldRankRects.set(key,node.getBoundingClientRect())}
 const frag=document.createDocumentFragment();
 for(let i=0;i<rows.length;i++){
  const b=rows[i],rank=b.rank||i+1,key=String(b.ballId||`${b.name}-${b.copy||1}-${i}`),status=b.live?'live':b.preview?'preview':'done';
  keep.add(key);let node=rankNodes.get(key);
  if(!node){node=document.createElement('div');node.className='rankItem';node.innerHTML='<span class="rankCheck"></span><span class="rankName"></span><span class="rankCopy"></span>';rankNodes.set(key,node)}
  const hue=getNameHue(b.name),rowHue=(rank*31+318)%360;
  node.style.setProperty('--rainbow',getNameColor(b.name,1));node.style.setProperty('--rainbowSoft',getNameColor(b.name,.10));
  node.querySelector('.rankCheck').textContent=status==='done'?'✓':'○';
  node.querySelector('.rankName').textContent=b.name;
  // #숫자는 공의 복사 번호가 아니라 실제 결승 진입 순서다. 아직 들어가지 않은 공에는 표시하지 않는다.
  node.querySelector('.rankCopy').textContent=status==='done'?'#'+rank:'';
  node.classList.toggle('live',!!b.live);node.classList.toggle('preview',!!b.preview);node.classList.toggle('done',status==='done');
  const prev=rankStatusCache.get(key);if(prev&&prev!=='done'&&status==='done'){node.classList.remove('newArrival');void node.offsetWidth;node.classList.add('newArrival')}
  rankStatusCache.set(key,status);frag.appendChild(node);
 }
 for(const [key,node] of rankNodes){if(!keep.has(key)){node.remove();rankNodes.delete(key);rankStatusCache.delete(key)}}
 el.appendChild(frag);
 // 대량 공 + 마지막 당첨 모드에서 DOM 재배치가 브라우저 스크롤 위치를 위로 보정하는 현상 방지.
 if(state.status==='running'&&state.winMode==='last'&&el.scrollTop<scrollTopBeforeRender)el.scrollTop=scrollTopBeforeRender;
 if(allowRankFlip)requestAnimationFrame(()=>{for(const [key,node] of rankNodes){const before=oldRankRects.get(key);if(!before||!node.isConnected)continue;const after=node.getBoundingClientRect(),dy=before.top-after.top;if(Math.abs(dy)>.5){node.style.transition='none';node.style.transform=`translateY(${dy}px)`;node.getBoundingClientRect();node.style.transition='transform 650ms cubic-bezier(.22,.75,.25,1)';node.style.transform='translateY(0)'}}});
 // 목록 갱신 때 위치가 툭 끊기지 않도록, 현재 진행 지점을 향해 계속 부드럽게 자동 스크롤한다.
 const latestKey=finished.length?String(finished[finished.length-1].ballId||''):'';
 if(hasLive){
  const anchorKey=latestKey||String(rows[Math.min(rows.length-1,Math.max(0,Math.floor(el.clientHeight/28)-2))]?.ballId||'');
  const finishedChanged=finished.length!==rankAutoScrollLastFinished;
  if(finishedChanged){
   rankAutoScrollLastFinished=finished.length;
   // 첫 번째 체크가 뜬 직후에는 목록을 맨 위에 잠시 고정해 #1부터 충분히 확인하게 한다.
   // 이후에만 기존의 부드러운 자동 스크롤을 시작한다.
   if(finished.length===1){rankAutoScrollFirstHoldUntil=now+3000;rankAutoScrollNextAt=rankAutoScrollFirstHoldUntil;rankAutoScrollTarget=0;if(rankAutoScrollRaf){cancelAnimationFrame(rankAutoScrollRaf);rankAutoScrollRaf=0}el.scrollTop=0}
   else rankAutoScrollNextAt=Math.max(now+650,rankAutoScrollFirstHoldUntil||0);
  }
  requestAnimationFrame(()=>{
   // 첫 체크 표시 후 3초 동안은 절대 아래로 넘기지 않는다.
   if(rankAutoScrollFirstHoldUntil&&performance.now()<rankAutoScrollFirstHoldUntil){el.scrollTop=0;return}
   const anchor=rankNodes.get(anchorKey);
   if(!anchor)return;
   const viewTop=el.scrollTop,viewBottom=viewTop+el.clientHeight;
   const rowTop=anchor.offsetTop,rowBottom=rowTop+anchor.offsetHeight;
   // 새 체크는 화면 아래쪽 68% 부근에 머물게 해 체크 표시와 이름을 충분히 보여준다.
   // 아직 화면 안에 잘 보이면 불필요하게 다음 항목까지 미리 넘기지 않는다.
   const comfortablyVisible=rowTop>=viewTop+el.clientHeight*.16&&rowBottom<=viewTop+el.clientHeight*.78;
   if(comfortablyVisible)return;
   const apply=()=>{
    if(rankAutoScrollLocked)return;
    const target=Math.max(0,rowTop-el.clientHeight*.68+anchor.offsetHeight*.5);
    setRankAutoScroll(el,target);
   };
   const wait=Math.max(0,rankAutoScrollNextAt-performance.now());
   if(wait>8)setTimeout(apply,wait);else apply();
  });
  if(latestKey)renderRank.lastScrollKey=latestKey;
 }
 if($('counter'))$('counter').textContent=finished.length+' / '+balls().length;
 const targets=state.winMode==='first'?[1]:state.winMode==='last'?[balls().length]:(state.winningRanks||[1]);
 const winnerReached=targets.some(r=>finished.length>=r);
 if(winnerReached)cancelRankAutoScroll();
 if(winnerReached&&!renderRank.winnerLocked){renderRank.winnerLocked=true;const targetRank=Math.min(...targets.filter(r=>r<=finished.length));const target=el.children[targetRank-1];if(target)target.classList.add('winnerArrival')}
 if(!hasLive){renderRank.lastScrollKey='';renderRank.winnerLocked=false;rankAutoScrollTarget=0;if(!rankAutoScrollLocked)el.scrollTop=0}
}
function renderWinner(){
 const card=$('winnerCard'),names=$('winnerNames');if(!card||!names||!state)return;
 let winners=state.winners||[];
 if(!winners.length&&state.status==='running'){
  const f=state.finishOrder||[];
  if(state.winMode==='first'&&f.length>=1)winners=[f[0]];
  else if(state.winMode==='number'){const ranks=state.winningRanks||[],max=Math.max(0,...ranks);if(f.length>=max)winners=ranks.filter(r=>r<=f.length).map(r=>f[r-1])}
 }
 if(!winners.length){winnerPopupFirstSeenAt=0;card.classList.remove('show');return}
 const now=performance.now();if(!winnerPopupFirstSeenAt)winnerPopupFirstSeenAt=now;
 // 위너 팝업은 당첨 공이 결승 직선 낙하를 끝낸 뒤에만 표시한다.
 // 관리자 로컬 물리에서는 실제 당첨 공 done 시점을 사용하고, 원격 화면은 스냅샷 done 또는 안전 지연을 사용한다.
 let dropFinished=true;
 if(sim?.winnerResolved){
  const focused=sim.balls?.find(b=>String(b.ballId)===String(sim.focusBallId));
  const previewEnd=Math.max(Number(sim.winnerPopupNotBefore||0),Number(sim.finishZoomUntil||0));
  // 당첨공은 약 1.5초만 확대 추적한다. 이후 공이 통로 아래로 계속 움직이더라도
  // 카메라는 더 따라가지 않고 메인 구도로 복귀한 뒤 Winner 팝업을 표시한다.
  if(!sim.winnerPopupReady&&now>=previewEnd){
   sim.winnerPopupReady=true;
   sim.winnerPopupReadyAt=now;
   sim.firstWinnerPreview=false;
   if(focused){focused.finishVisualUntil=Math.max(Number(focused.finishVisualUntil||0),now+4200)}
   sim.focusBallId='';sim.finishZoomStart=0;sim.finishZoomUntil=0;
   const activeMap=sim.map||mapDef(state?.map||'wheel',state?.seed||1);
   sim.winnerReturnY=Math.max(0,(activeMap.finalZone?.top??activeMap.finishY-700)-260);
   sim.winnerReturnUntil=now+1500;sim.bottomCameraLocked=false;sim.cameraHoldUntil=0;manualCam=null;
  }
  // 공 자체는 뒤에서 계속 물리적으로 진행할 수 있지만, 팝업 타이밍은 짧은 클로즈업 종료 시점 기준이다.
  dropFinished=!!sim.winnerPopupReady&&now>=Number(sim.winnerPopupReadyAt||0);
 }
 else{
  const snap=state.snapshot?.balls||[];
  const winnerIds=new Set(winners.map(w=>String(w.ballId||'')));
  const matched=snap.filter(b=>winnerIds.has(String(b.ballId||'')));
  const popupY=Number(mapDef(state?.map||'wheel',state?.seed||1)?.popupY??Infinity);
  if(matched.length)dropFinished=(now-winnerPopupFirstSeenAt>=800)&&matched.some(b=>b.done||Number(b.y)>=popupY);
  else dropFinished=now-winnerPopupFirstSeenAt>=800;
 }
 if(!dropFinished){card.classList.remove('show');return}
 const winnerMarkup=winners.map(w=>`<span>${esc(w.name)}</span>`).join('');
 // 매 프레임 innerHTML 재작성과 강제 레이아웃(offsetWidth)을 피해서 팝업 순간 렉을 줄인다.
 if(names.dataset.markup!==winnerMarkup){names.innerHTML=winnerMarkup;names.dataset.markup=winnerMarkup}
 card.classList.add('show');card.dataset.effectProfile='global';
 if(lastWinnerRace!==state.raceId){
  lastWinnerRace=state.raceId;
  // 기존 애니메이션 상태를 확실히 비운 다음 두 프레임 뒤 재생해
  // 플래시·반짝임·왕관 효과가 매 경기 빠짐없이 다시 시작되게 한다.
  card.classList.remove('burst','winner-pop');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
   if(lastWinnerRace===state?.raceId){
    card.classList.add('winner-pop');
   }
  }));
 }
}
function advanceFastForwardClock(extraMs){
 if(!sim||!canvasDragFastForward||!Number.isFinite(extraMs)||extraMs<=0)return;
 // 물리 스텝만 늘리는 것이 아니라 경기 내부의 시간 기준도 같은 만큼 앞당긴다.
 // 따라서 공 배출, 정체 구조, 제한시간과 결과 확정까지 실제로 5배 빠르게 진행된다.
 const shift=Math.min(320,extraMs*4);
 const simKeys=['startedAt','startReleaseAt','startEffectsAt','hardDeadlineAt','impactDisabledUntil','chuteNextReleaseAt','entrySlowUntil','slowUntil','winnerPopupReadyAt','winnerPopupNotBefore','winnerResolvedAt'];
 for(const k of simKeys){if(Number.isFinite(sim[k])&&sim[k]>0)sim[k]-=shift}
 for(const b of sim.balls||[]){
  const keys=['releaseAt','stunStart','stunUntil','stunCooldownUntil','ghostUntil','lastRescueAt','lastWallBounceAt','lastGateKickAt','lastGateTouchAt','gateContactUntil','gateLiftUntil','lastFlowBounceAt','lastLowerBounceAt','lastFinalSeparateAt','impactUntil','skillCoolTime','winnerHideAt'];
  for(const k of keys){if(Number.isFinite(b[k])&&b[k]>0)b[k]-=shift}
 }
}

function setFastForward(active){
 canvasDragFastForward=!!active;
 if(sim){
  sim.userSpeedScale=canvasDragFastForward?5:1;
  sim.acc=Math.min(sim.acc||0,8.333);
  sim.last=performance.now();
  sim.cameraFrameTs=performance.now();
 }
 let badge=$('speed2xBadge');
 if(!badge){
  badge=document.createElement('div');badge.id='speed2xBadge';badge.textContent='5×';
  Object.assign(badge.style,{position:'fixed',zIndex:'9999',right:'286px',top:'92px',padding:'7px 12px',borderRadius:'999px',font:'900 18px Pretendard, sans-serif',color:'#fff',background:'rgba(10,12,20,.82)',border:'1px solid rgba(255,255,255,.3)',pointerEvents:'none',opacity:'0',transform:'scale(.9)',transition:'opacity .16s ease, transform .16s ease'});
  document.body.appendChild(badge);
 }
 badge.style.opacity=canvasDragFastForward?'1':'0';badge.style.transform=canvasDragFastForward?'scale(1)':'scale(.9)';
}
function bindCanvasFastForward(main){
 if(!main||main.dataset.fastForwardBound==='1')return;
 main.dataset.fastForwardBound='1';
 main.style.touchAction='none';
 main.style.userSelect='none';
 let tracking=false,startX=0,startY=0,pointerId=null,activated=false;
 const end=()=>{if(!tracking)return;tracking=false;activated=false;pointerId=null;setFastForward(false)};
 main.addEventListener('pointerdown',e=>{
  if(role!=='admin'||!sim||e.button!==0||e.target!==main)return;
  tracking=true;activated=false;pointerId=e.pointerId;startX=e.clientX;startY=e.clientY;
  try{main.setPointerCapture(pointerId)}catch{}
 },{passive:true});
 main.addEventListener('pointermove',e=>{
  if(!tracking||e.pointerId!==pointerId)return;
  e.preventDefault();
  const dx=e.clientX-startX,dy=Math.abs(e.clientY-startY);
  if(!activated&&dx>=52&&dy<=90){activated=true;suppressNextCanvasClick=true;setFastForward(true)}
  if(activated&&dx<20){activated=false;setFastForward(false)}
 },{passive:false});
 main.addEventListener('pointerup',end,{passive:true});
 main.addEventListener('pointercancel',end,{passive:true});
 main.addEventListener('lostpointercapture',end,{passive:true});
 window.addEventListener('blur',end,{passive:true});
}
function bindMinimapNavigation(){
 const c=$('minimapCanvas');if(!c||c.dataset.navBound)return;c.dataset.navBound='1';c.style.cursor='crosshair';c.title='클릭하면 해당 맵 구간으로 이동 · 메인 화면 클릭 또는 Space로 자동 추적 복귀';
 c.addEventListener('click',e=>{if(role!=='admin'||!sim)return;const rect=c.getBoundingClientRect(),pad=5,ratio=clamp((e.clientY-rect.top-pad)/Math.max(1,rect.height-pad*2),0,1),mh=sim.map.worldH||H,viewPx=$('raceCanvas')?.clientHeight||700,canvasW=$('raceCanvas')?.clientWidth||1200,baseScale=Math.min((canvasW-250)/W,1.02),viewWorld=viewPx/Math.max(.01,baseScale*(sim.camZoom||.82));manualCam=clamp(ratio*mh-viewWorld/2,0,mh-viewWorld+40);flash('미니맵 위치로 카메라 이동 · 메인 화면 클릭 시 자동 추적 복귀')});
 const main=$('raceCanvas');
 if(main&&!main.dataset.autoCamBound){
  main.dataset.autoCamBound='1';bindCanvasFastForward(main);
  main.addEventListener('click',()=>{if(suppressNextCanvasClick){suppressNextCanvasClick=false;return}if(role==='admin'&&manualCam!==null){manualCam=null;if(sim)sim.cameraHoldUntil=0;flash('자동 카메라로 복귀')}})
 }
 window.addEventListener('keydown',e=>{if(e.code==='Space'&&role==='admin'&&manualCam!==null){e.preventDefault();manualCam=null;if(sim)sim.cameraHoldUntil=0;flash('공 자동 추적으로 복귀')}})
}
function bindUnified(){
 unifiedMode=true;role='admin';selectedMapLock=null;
 loadAdminPrefs();bindAdmin();
 owner=localStorage.getItem('pin_owner_'+room)||localStorage.getItem('pin_owner')||'';
 const ownerEl=$('ownerInput');if(ownerEl)ownerEl.value=owner;
 const saveOwner=()=>{owner=ownerEl?.value.trim()||'';if(!owner){flash('내 이름을 입력해주세요');return false}localStorage.setItem('pin_owner_'+room,owner);localStorage.setItem('pin_owner',owner);flash('이름 저장 완료');return true};
 const saveOwnerBtn=$('saveOwner');if(saveOwnerBtn)saveOwnerBtn.onclick=saveOwner;
 const currentOwner=()=>{const typed=ownerEl?.value.trim()||'';if(typed&&typed!==owner){owner=typed;localStorage.setItem('pin_owner_'+room,owner);localStorage.setItem('pin_owner',owner)}return owner||''};
 const addOne=()=>{const who=currentOwner();if(!who){flash('먼저 내 이름을 입력하고 저장해주세요');return}const n=$('nameInput')?.value.trim()||'';const c=+$('countInput')?.value||1;if(!n){flash('참가 닉네임을 입력해주세요');return}api('addParticipant',{name:n,count:c,owner:who}).then(()=>{if($('nameInput'))$('nameInput').value='';flash('현재 선택한 핀볼에 등록 완료')}).catch(e=>flash(e.message||'등록 오류'))};
 const addBulk=()=>{const who=currentOwner();if(!who){flash('먼저 내 이름을 입력하고 저장해주세요');return}const items=parseBulk($('bulkInput')?.value||'');if(!items.length){flash('일괄 추가할 참가자를 입력해주세요');return}api('bulkAdd',{items,owner:who}).then(()=>{if($('bulkInput'))$('bulkInput').value='';flash(`${items.length}명 일괄 추가 완료`)}).catch(e=>flash(e.message||'일괄 추가 오류'))};
 if($('addBtn'))$('addBtn').onclick=addOne;
 if($('bulkBtn'))$('bulkBtn').onclick=addBulk;
 const nameEl=$('nameInput');if(nameEl)nameEl.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addOne()}});
}
function init(r){if(r==='unified')bindUnified();else{role=r;if(r==='admin'){loadAdminPrefs();bindAdmin();}if(r==='member')bindMember();}bindMinimapNavigation();bindSharedInteractions();connectRoomEvents();poll();requestAnimationFrame(draw)}return{init}})();

// v9.3: 전 맵 가로 통로 확대, 결승 집결부/일자 통로 확장, 순위 #공번호 항상 표시 및 ballId 폴백.

// v11.5: 플리퍼 좌표 순간이동 보정 제거, 제한적 분리 보정, 고정 프레임 기반 연속 슬로우모션.

// v12.9: 백그라운드 전환 시 물리 상태 보존·복귀 점프/자동리셋 차단, 오른쪽 #숫자를 결승 진입 순서로 변경.

// v13.5-clumpfix: center-outward wall piling removed; local collision separation + upper mixer added.

// v13.7: right-side flow balancing + randomized one-ball chute scheduler.

// v13.8-no-stuck: all-map per-ball rescue + stronger jam release; fixed bumper/peg pockets cannot hold a ball indefinitely.

// v13.9-right-wall-ride: balls already touching the right rail follow its downward tangent instead of bouncing into a center stack.

// v13.10-three-lane-approach: lower approach spreads balls across left/center/right with per-ball speed variance before randomized single-file chute entry.

// v13.11-right-wall-natural-merge: right rail riders stay on the rail through the lower funnel and merge only at the chute mouth.

// v13.12-natural-wall-slide: removed sticky right-wall tracking; map1 top bumpers/spinners removed.
// v13.13-lower-queue-rebuild: three staggered approach queues prevent central pileups and feed one random front ball at a time.

// v13.14-right-side-file: lower right approach keeps a visible wall-following file and merges only when released.

// v13.15-right-wall-weighted-drop: removed right-lane vertical speed cap and added immediate gravity-led wall drop.
// v13.16-clean-wall-entry: removed yellow peg field and stopped chute-entry center suction so side balls follow the physical walls into the mouth.

// v13.17-chute-continuity: side-wall travel is preserved until the final 72px, then smoothly merged into the chute; added missed-finish failsafe.

// v13.19: final-zone collision/queue boundaries now use the actual widened map geometry; removes false center clumping and right-side dead space.

// v13.20-upper-slow-lower-fast: slower upper gravity, stronger lower drain, and faster chute queue release.
// v13.21-right-fill-gate-slow: gently fills lower-right dead space and slows the final spinner to prevent upward re-kicks.
// v13.22-no-competition-slow-staggered-release: removes competition slowdown and releases shuffled balls one by one.

// v13.23-long-zigzag-map: wheel map height extended to 7600px with repeated left/right bends for a longer, less congested race.

// v13.24-open-flow-90sec: gentler 6600px candy course, side-only slow mixers, no random blockers, timed downward flow guarantee.

// v13.25-open-finish: widened the finish chute, removed the blocking spinner and queue freeze, and guarantees continuous downward drainage.

// v13.26-fun-three-lane: restored controlled pinball bounce, added S-flow + small spinners + three-lane final competition, then one-ball chute.

// v13.27-1000ball-base: adaptive release, 60~120Hz physics, final-only second solver, adaptive snapshots, dense rendering mode.

// v13.28-reference-tower: recreated the uploaded long zigzag map with detailed wall bends, central island, chevrons, V-guides and lower peg grid while keeping 1000-ball-safe clearances.

// v14.0-reference-engine: rebuilt the primary map as a reusable data-driven Polyline/Kinematic stage based on the supplied reference implementation.

// v14.3-display-zoom: enlarged race viewport and visual marble radius while preserving original Box2D collision radius.

// v14.90-greed-original-flow: 욕망의 항아리 외벽·다이아 장애물·상단 2회전바·하단 좌우 9연속 회전바를 원본 물리 패턴으로 교체.

// v14.90-greed-natural-chute: 중앙 직통로는 강제 속도 없이 중력 낙하, Impact·정체 해제 impulse만 제외.

// v14.92-greed-prewinner-framing: 당첨 10개 전 욕망의 항아리 하단 회전바·중앙 입구·직선 통로 시작부를 예시 화면 비율로 고정 프레이밍.

// v14.93-common-prewinner-focus: 모든 맵에서 지정 당첨 순번 10개 전부터 단계적으로 줌인하며, 기본 경기 속도는 0.7배속.

// v14.94-greed-roaming-to-lock: 욕망의 항아리는 상단 공 무리를 추적하다가 목표 15개 전부터 예시 하단 프레임으로 이동해 10개 전에 고정.

// v14.96-greed-camera-no-early-drop: 욕망의 항아리는 시작 직후 하단 고정을 금지하고, 상단 공 무리를 추적하다 목표 15개 전부터만 자연스럽게 하단 프레임으로 이동.

// v14.97-comfort-camera: 평소에는 넓고 안정적인 구도를 유지하고, 당첨 직전과 확정 순간에만 과하지 않은 확대를 적용.

// v14.98-prewinner-tikitaka: 당첨 10개 전 결승 입구에서 공끼리 좌우 티키타카를 강화하되 위로 강제 발사하지 않음.

// v14.99-one-shot-winner-closeup-all-drop: 당첨 진입 공을 0.30배속 원샷 클로즈업하며, 모든 맵에서 시작 즉시 전 공을 활성화하고 상단 정체 공에 짧은 하향 보조를 적용.

// v15.00-start-rain-winner-after-drop: 시작 1.5초 Impact 금지·넓은 배치·초기 하향속도로 전 공 동시 낙하, 위너 팝업은 당첨 공 낙하 완료 뒤 표시.

// v15.03-dynamic-point-camera: 평상시에도 공 밀집 구간과 주요 장애물 포인트를 약 1.85초 간격으로 자연스럽게 순회하며 카메라 반응 속도를 개선.

// v15.06-progress-aware-camera-tour: 목표 당첨 순번 진행률에 따라 상단·중간 지형·하단을 유연하게 순회하고, 너무 이른 하단 고정을 방지.

// v15.08-final-four-ultra-slow: 지정 당첨 순번 3개 전부터 마지막 4개 공을 0.22배속, 당첨 공은 0.16배속으로 보여주며 저속 하한을 실제로 허용.

// v15.09-winner-popup-recovery: Box2D/JS 양쪽 물리에서 당첨 공 낙하 완료 시 popupReady를 설정하고, 누락 시 9.5초 안전 복구로 팝업 영구 미표시를 방지.

// v15.10-adaptive-early-winner-and-gate-reject: 앞번호 당첨은 실제 결승 접근 시에만 짧게 감속하며, 마지막 핀볼 막대 접촉 공은 통과 판정 없이 위로 반사 후 재도전.

// v15.10a-winner-drop-minus-2s: 당첨 공 낙하·클로즈업·슬로우 연출 시간을 기존보다 약 2초 단축.

// v15.10c-flow-first-camera: 당첨 촬영 시작 시 결승 입구로 선이동하지 않고 선두 공을 따라 내려오며 자연스럽게 결승 프레임으로 전환.

// v15.10f-winner-chute-fixed-2s: 당첨 공이 결승 입구에 진입한 시점부터 낙하 연출을 2초로 고정하고 즉시 Winner 팝업 표시.

// v15.10g-winner-at-visible-chute-end: both wheel and greed show Winner exactly when the selected ball reaches the visible end of the final vertical chute.

// v15.10h-winner-marble-pop: selected winner marble drops through the chute, pops upward in front of the persistent Winner card, and stays visible while the card remains open.

// v15.10i-winner-disappear-pop: selected winner ball vanishes at the visible chute end, then the persistent Winner card pops in without a marble graphic.

// v15.10j-winner-instant-vanish-return: 당첨 확정 즉시 공을 숨기고, 카메라가 메인 핀볼 구간으로 올라가면서 Winner 팝업을 유지.

// v15.10k-rank-manual-scroll-lock: 경기 종료/당첨 이후 또는 사용자가 목록을 직접 스크롤하면 자동 스크롤을 즉시 중단하고, 다음 레이스에서만 다시 활성화.

// v15.10n-stop-bottom-follow-crown: 당첨 확정 즉시 하단 추적을 종료하고 메인 구도로 복귀, Winner 팝업 상단에 왕관 추가.

// v15.10p-winner-closeup-crown-straight: 당첨 확정 후 1.5초 클로즈업, 이후 공 숨김·메인 복귀·팝업 표시. 왕관은 정중앙 수평 대칭.

// v15.10q-greed-remix-all-candy-effects: 욕망의 항아리 REMIX에 캔디 수레바퀴와 동일한 하단 고정·10개 전 카메라·6개 전 줌·1.5초 당첨 클로즈업·메인 복귀·왕관 Winner 연출 적용. 중앙 통로 판정은 유지.

// v15.10r-greed-remix-finish-sync: 욕망의 항아리 중앙 통로 실제 통과만 순위로 인정하고, 로컬 체크·1.5초 클로즈업·Winner 팝업을 즉시 동기화.

// v15.10v-popup-after-drop-and-clear-on-restart: Winner popup waits until the 1.5s drop closeup has fully ended, and starting a new race immediately clears the previous popup.

// v15.10w-greed-drop-fixed-frame: 욕망의 항아리 당첨 낙하 연출은 하단 회전바·중앙 입구·세로 통로가 함께 보이는 고정 화면으로 유지하고, 팝업은 낙하 연출 종료 뒤 표시.

// v15.10aa-greed-informative-calm-camera: 욕망의 항아리 전용 상단분기-몸통-중앙입구 카메라 프리셋, 빈 공간 추적 제거, 전 맵 카메라 흔들림 완화.

// v15.10ac-greed-entry-anchor-background-continuity: 욕망 항아리 왕관 위 Y자 입구를 고정 카메라 앵커로 사용하고, 다른 탭에서도 물리를 계속 진행해 복귀 리셋을 방지.

// v15.10ah-greed-probable-candidate-camera: 욕망의 항아리 일반 진행은 공 평균 대신 입구 도달 가능성이 높은 후보 공을 점수화해 추적하고, 최종 연출은 실제 당첨공을 추적.

// v15.10aq-greed-exact-dual-anchor: 사용자 지정 결승(566.25,2900.99,.9459)을 메인으로 유지하고 9.5초 주기 중 2초간 중앙 입구(560.18,2383.24,.9403)를 보여준 뒤 복귀. 당첨 준비·당첨 연출은 결승 좌표 우선.

// v15.10ar-greed-early-flow-late-anchor: 욕망의 항아리 초반~중반은 내려오는 선두 공 흐름을 자동 추적하고, 후반부터 결승 좌표를 메인으로 유지하며 중앙 상태 좌표를 3초간 보여준다.
// v15.10as-greed-broadcast-camera-cycle: 후반부에 결승 4.5초→중앙 3초→유력 후보 3초→중앙 2.5초→결승 3초 순으로 부드럽게 반복하고, 당첨 직전에는 결승 좌표로 고정한다.

// v15.10au-greed-unlocked-camera-drag-2x: 욕망의 항아리 하단 결승 고정 제거. 공 흐름 중심 자동 카메라 유지. 메인 화면을 오른쪽으로 52px 이상 드래그하는 동안 물리만 2배속, 손을 떼면 즉시 정상 속도 복귀. 당첨공 슬로우 중에는 2배속 비활성.

// v15.10av-greed-exact-competition-waypoint: 결승 경쟁 화면은 사용자 지정 좌표(566.25,2900.99,.9459)를 정확히 사용하되 영구 고정하지 않고 5초 중계 순환의 한 지점으로 유지. 실제 당첨공 연출 시 자동 추적으로 전환.

// v15.10aw-greed-final-coordinate-restored: 경쟁구간 결승 포인트를 X=566.25, Y=2900.99, Zoom=.9459로 정확히 복구하고, 영구 고정 대신 5초 중계 순환에 포함.

// v15.10ax-real-2x-fast-forward: 오른쪽 드래그 2배속이 표시만이 아니라 물리 스텝·공 배출·정체 타이머·경기 제한시간까지 함께 2배로 진행되도록 내부 경기 시계를 동기화.

// v15.10ay-last-winner-continues-behind-popup: 마지막 한 공은 결과를 즉시 확정하고 Winner 팝업을 띄우되 삭제·숨김 없이 실제 결승 통로에 들어갈 때까지 물리를 계속 진행.

// v15.10ba-winner-follow-full-drop: 당첨공이 입구에 진입한 뒤에도 카메라가 실제 하단 낙하 경로를 끝까지 따라가며, 타이머로 공을 조기 숨기지 않는다.

// v15.10bd-short-winner-follow: 당첨공 확대 추적은 약 1.5초만 유지하고, 이후 하단 끝까지 카메라가 따라가지 않으며 공은 팝업 뒤에서 계속 물리 진행.
// v15.10bg-popup-immediate-after-short-drop: 당첨공의 짧은 낙하 확인 약 0.7초가 끝나는 즉시 Winner 팝업을 표시하고 추가 대기 지연을 제거.

// v15.10bh-wheel-short-drop-popup-immediate: 캔디 수레바퀴를 포함한 모든 맵의 당첨공 낙하 확인 시간을 0.7초로 통일하고, 종료 즉시 Winner 팝업을 표시한다.

// v15.10bi-wheel-normal-speed-separated: 캔디 수레바퀴 기본 물리 속도는 1배속으로 복구하고, 0.7초 당첨공 낙하 연출 슬로우와 Winner 팝업 타이밍을 물리 진행 속도에서 분리.

// v15.10bp-rank-first-visible-hold: 오른쪽 목록은 첫 체크(#1)를 맨 위에서 3초간 충분히 보여준 뒤에만 자동 스크롤을 시작하며, 이후 체크도 0.65초 이상 간격으로 부드럽게 이동.

// v15.10bj-real-5x-fast-forward: 메인 캔버스를 오른쪽으로 드래그하는 동안 물리 스텝과 경기 내부 타이머를 실제 5배속으로 진행. 당첨공 시네마틱/슬로우 중에는 비활성.

// v15.10bk-physical-5x-drop-boost: 5배속 중 실제 공의 수직 속도와 결승 통로 낙하 속도를 함께 가속해 결과 도달 시간을 체감 가능하게 단축.

// v15.10bl-fast-forward-rotors-low-impact: 5배속 중 회전 구조물도 실제 5배로 회전하며, Impact/랜덤 구제 힘은 낮춰 공이 입구로 더 빠르게 배출되도록 최적화.

// v15.10bo-fast-forward-real-downforce: 5배속 중 Box2D 중력과 실제 바디 하강 속도를 직접 강화하고, 비-Box2D 맵의 수직 속도 하한도 높여 공이 눈에 띄게 빠르게 입구로 내려가도록 수정.

// v15.10bq-fast-forward-camera-stability: 5배속에서 카메라 타이머 가속을 분리하고 살아있는 공 무리를 안정 추적해 화면 이탈을 방지.

// v15.10br-fast-forward-bounds-vector-flow: 5배속에서 공의 기존 벡터·충돌 흐름을 유지한 채 가속하고, Box2D/레거시 맵 경계 이탈을 자동 복귀하도록 수정.

// v15.10bs-fast-forward-neon-containment: 5배속은 고속 벡터 강제가 아닌 고정 물리 서브스텝 5배 실행으로 변경. 공을 bullet body로 설정해 네온 벽 관통·맵 이탈을 차단하고, 모든 맵에서 실제 진행을 5배 가속.

// v15.10bt-fast-forward-camera-hard-clamp: 5배속 드래그 중 카메라 X/Y/줌을 매 프레임 맵 가시 범위에 강제 제한하고 브라우저 드래그 스크롤을 차단해 핀볼창 화면 이탈을 방지.

// v15.10bu-stable-fast-forward: 5배속 중복 회전 가속·타임스탬프 강제 이동·카메라 재추적을 제거하고, 프레임당 고정 서브스텝 수를 제한해 멈춤과 화면 이탈을 방지.

// v15.10bv-fast-forward-nonblocking-root-fix: 5배속 중 프레임당 Box2D 계산 폭주와 자동복구 재시작을 제거. 현재 물리 월드를 유지한 채 제한된 서브스텝, 강화 중력, 회전체 2.25배, 점진 하강 보조로 결과를 빠르게 처리하며 UI/카메라 멈춤과 0/전체 초기화를 방지.

// v15.10bw-fast-forward-tdz-screen-loss-fix: drawFrame에서 선언 전 winnerCinematic 참조로 발생하던 ReferenceError를 제거해 5배속 중 핀볼 화면 소실과 진행 정지를 근본 수정.

// v15.10bx-fast-forward-greed-neon-wall-containment: 5배속 중 욕망의 항아리 공을 실제 좌우 네온 외곽선의 구간별 기울기 안쪽으로 제한하고, 밖으로 향한 횡속도만 흡수해 맵 이탈을 차단.
