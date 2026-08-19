const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=__dirname,PORT=Number(process.env.PORT||10000),rooms=new Map(),streams=new Map(),now=()=>Date.now();
const clean=s=>String(s||'COMMON').replace(/[^A-Za-z0-9_-]/g,'').toUpperCase()||'COMMON',sid=()=>crypto.randomBytes(12).toString('hex'),snap=()=>({balls:[],rot:[],gate:0,cam:0,camX:560,camZoom:.82});
function fresh(code){return{code,mode:'group',title:'Yamyam Marble Pinball',map:'wheel',status:'lobby',participants:[],winMode:'first',winningRanks:[1],raceBalls:[],finishOrder:[],winners:[],snapshot:snap(),raceId:0,seed:1,shuffleNonce:0,winnerDeclared:false,startedAt:0,duration:0,paused:false,pausedAt:0,leaderId:'',leaderBeat:0,updatedAt:now()}}
function R(c){c=clean(c);if(!rooms.has(c))rooms.set(c,fresh(c));return rooms.get(c)}function touch(r){r.updatedAt=now()}function lobby(r){r.status='lobby';r.raceBalls=[];r.finishOrder=[];r.winners=[];r.winnerDeclared=false;r.snapshot=snap();r.startedAt=0;r.paused=false;r.pausedAt=0;r.leaderId='';r.leaderBeat=0}
function meta(r){let x={...r};delete x.raceBalls;delete x.snapshot;return x}function leaderAlive(r){return r.leaderId&&now()-r.leaderBeat<5500}function leader(r,c){if(c&&(!leaderAlive(r)||r.leaderId===c)){r.leaderId=c;r.leaderBeat=now()}return r.leaderId}
function send(res,s,o){let b=Buffer.from(JSON.stringify(o));res.writeHead(s,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store'});res.end(b)}
function body(req){return new Promise((ok,no)=>{let s='';req.on('data',d=>s+=d);req.on('end',()=>{try{ok(s?JSON.parse(s):{})}catch(e){no(e)}});req.on('error',no)})}

function streamSet(code){code=clean(code);if(!streams.has(code))streams.set(code,new Set());return streams.get(code)}
function pushRoom(r){
 const payload=`data: ${JSON.stringify({state:meta(r),serverNow:now()})}\n\n`;
 for(const res of [...streamSet(r.code)]){try{res.write(payload)}catch(_){streamSet(r.code).delete(res)}}
}
async function act(d){let r=R(d.room),a=String(d.action||''),cid=String(d.clientId||'');
 if(a==='addParticipant'||a==='bulkAdd'){if(r.status==='running')throw Error('Race is running.');let items=a==='bulkAdd'?(d.items||[]):[{name:d.name,count:d.count}],owner=String(d.owner||'').slice(0,40);for(let q of items){let name=String(q.name||'').trim();if(name&&name.length<=24)r.participants.push({id:sid(),name,owner,count:Math.max(1,Math.min(100000,Number(q.count)||1)),addedAt:now()})}lobby(r);touch(r)}
 else if(a==='removeParticipant'||a==='removeParticipants'){if(r.status==='running')throw Error('Race is running.');let ids=new Set(a==='removeParticipant'?[String(d.id)]:(d.ids||[]).map(String));r.participants=r.participants.filter(p=>!ids.has(String(p.id)));lobby(r);touch(r)}
 else if(a==='adjustParticipantGroup'){if(r.status==='running')throw Error('Race is running.');let ids=new Set((d.ids||[]).map(String)),m=r.participants.filter(p=>ids.has(String(p.id)));if(!m.length)throw Error('Participant not found.');let cur=m.reduce((n,p)=>n+Number(p.count||0),0),t=d.count!=null?Number(d.count):cur+Number(d.delta||0);t=Math.max(0,Math.min(100000,Math.trunc(t)));let keep=m[0].id;if(!t)r.participants=r.participants.filter(p=>!ids.has(String(p.id)));else{r.participants.forEach(p=>{if(p.id===keep)p.count=t});r.participants=r.participants.filter(p=>p.id===keep||!ids.has(String(p.id)))}lobby(r);touch(r)}
 else if(a==='setMode'){r.mode=d.mode;touch(r)}else if(a==='setTitle'){r.title=String(d.title||'').slice(0,50);touch(r)}
 else if(a==='setMap'){r.map=d.map;lobby(r);r.shuffleNonce++;r.seed=100000+Math.floor(Math.random()*2147383000);touch(r)}
 else if(a==='setWin'){r.winMode=d.winMode;r.winningRanks=d.winMode==='number'?[...new Set((d.ranks||[]).map(Number).filter(x=>x>0))]:[1];touch(r);return{ok:true,winMode:r.winMode,winningRanks:r.winningRanks,updatedAt:r.updatedAt}}
 else if(a==='shuffle'){if(r.status==='running')throw Error('Race is running.');lobby(r);r.shuffleNonce++;r.seed=100000+Math.floor(Math.random()*2147383000);touch(r)}
 else if(a==='startRace'){if(d.map)r.map=d.map;if(d.winMode){r.winMode=d.winMode;r.winningRanks=d.winMode==='number'?[...new Set((d.ranks||[]).map(Number).filter(x=>x>0))]:[1]}let balls=[];for(let p of r.participants)for(let i=1;i<=p.count;i++)balls.push({ballId:p.id+'_'+i,participantId:p.id,name:p.name,owner:p.owner,copy:i});if(!balls.length)throw Error('At least 1 ball is required.');r.raceBalls=balls;r.finishOrder=[];r.winners=[];r.winnerDeclared=false;r.snapshot=snap();r.raceId++;r.startedAt=now()+1800;r.status='running';r.paused=false;r.leaderId=cid;r.leaderBeat=now();touch(r);return{ok:true,raceId:r.raceId,seed:r.seed,status:r.status,map:r.map,winMode:r.winMode,winningRanks:r.winningRanks,startedAt:r.startedAt,leaderId:r.leaderId}}
 else if(a==='heartbeat'){if(r.status==='running')leader(r,cid);return{ok:true,leaderId:r.leaderId,paused:r.paused,updatedAt:r.updatedAt}}
 else if(a==='snapshot'){if(r.status==='running'&&leader(r,cid)===cid&&!r.paused){r.snapshot={balls:d.balls||[],rot:d.rot||[],gate:Number(d.gate)||0,cam:Number(d.cam)||0,camX:Number(d.camX)||560,camZoom:Number(d.camZoom)||.82};touch(r)}return{ok:true,leaderId:r.leaderId}}
 else if(a==='finishBall'){if(r.status==='running'&&leader(r,cid)===cid){let id=String(d.ballId);if(!r.finishOrder.some(x=>x.ballId===id)){let b=r.raceBalls.find(x=>x.ballId===id);if(b)r.finishOrder.push({ballId:b.ballId,name:b.name,copy:b.copy,owner:b.owner,rank:r.finishOrder.length+1})}if(!r.winnerDeclared){let ready=r.winMode==='first'?r.finishOrder.length>=1:r.winMode==='last'?r.finishOrder.length>=r.raceBalls.length:r.finishOrder.length>=Math.max(...r.winningRanks);if(ready){r.winners=r.winMode==='first'?[r.finishOrder[0]]:r.winMode==='last'?[r.finishOrder.at(-1)]:r.winningRanks.map(k=>r.finishOrder[k-1]).filter(Boolean);r.winnerDeclared=true}}touch(r)}return{ok:true}}
 else if(a==='pauseRace'){if(r.status==='running'){r.paused=true;r.pausedAt=now();touch(r)}}else if(a==='resumeRace'){if(r.status==='running'&&r.paused){r.startedAt+=now()-r.pausedAt;r.paused=false;r.pausedAt=0;touch(r)}}
 else if(a==='completeRace'){if(r.status==='running'&&leader(r,cid)===cid){r.status='completed';touch(r)}}else if(a==='resetRace'){lobby(r);r.shuffleNonce++;r.seed=100000+Math.floor(Math.random()*2147383000);touch(r)}
 else if(a==='clearParticipants'){lobby(r);r.participants=[];r.shuffleNonce++;r.seed=100000+Math.floor(Math.random()*2147383000);touch(r)}else throw Error('Unknown action.');
 return{ok:true,state:r}}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
http.createServer(async(req,res)=>{try{let u=new URL(req.url,'http://x'),p=decodeURIComponent(u.pathname);
 if(p==='/health'){res.writeHead(200);return res.end('ok')}if(p==='/api/meta')return send(res,200,{ok:true,state:meta(R(u.searchParams.get('room'))),serverNow:now()});
 if(p==='/api/state')return send(res,200,{ok:true,state:R(u.searchParams.get('room'))});if(p==='/api/checkpoint'){let r=R(u.searchParams.get('room'));return send(res,200,{ok:true,raceId:r.raceId,status:r.status,paused:r.paused,snapshot:r.snapshot,updatedAt:r.updatedAt,serverNow:now()})}
 if(p==='/api/action'&&req.method==='POST'){
   try{
    const d=await body(req),result=await act(d),r=R(d.room);
    if(!['snapshot','heartbeat'].includes(String(d.action||'')))pushRoom(r);
    if(['finishBall','completeRace'].includes(String(d.action||'')))pushRoom(r);
    return send(res,200,{...result,serverNow:now()})
   }catch(e){return send(res,400,{ok:false,error:e.message})}
 }
 if(p==='/api/events'){
   const code=clean(u.searchParams.get('room')),set=streamSet(code);
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   res.write(`retry: 1000\ndata: ${JSON.stringify({state:meta(R(code)),serverNow:now()})}\n\n`);
   set.add(res);const ping=setInterval(()=>{try{res.write(': ping\\n\\n')}catch(_){}},15000);
   req.on('close',()=>{clearInterval(ping);set.delete(res)});return;
 }
 if(p==='/')p='/index.html';let f=path.resolve(ROOT,'.'+p);if(!f.startsWith(ROOT)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);return res.end('Not found')}let b=fs.readFileSync(f);res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});res.end(b)
 }catch(e){send(res,500,{ok:false,error:e.message})}}).listen(PORT,'0.0.0.0',()=>console.log('Yamyam Pinball v21 on '+PORT));
