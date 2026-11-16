const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const PORT = process.env.PORT || 3000;

const TABLES = [
  ["TEX-100","Texas 100/200","texas",100,200],
  ["TEX-250","Texas 250/500","texas",250,500],
  ["TEX-500","Texas 500/1000","texas",500,1000],
  ["TEX-1K","Texas 1000/2000","texas",1000,2000],
  ["OMA-100","Omaha 100/200","omaha",100,200],
  ["OMA-250","Omaha 250/500","omaha",250,500],
  ["OMA-500","Omaha 500/1000","omaha",500,1000],
  ["OMA-1K","Omaha 1000/2000","omaha",1000,2000]
].map(([id,name,game,smallBlind,bigBlind])=>({id,name,game,smallBlind,bigBlind,maxPlayers:6}));

const rooms = new Map();
const socketRooms = new Map();
const suits = ["♠","♥","♦","♣"];
const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const val = r => ranks.indexOf(r)+2;
const deckNew = () => {
  const d=[]; for(const s of suits) for(const r of ranks) d.push({rank:r,suit:s});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
};
const combinations = (arr,n) => {
  const out=[]; const walk=(start,cur)=>{if(cur.length===n){out.push(cur);return;}for(let i=start;i<=arr.length-(n-cur.length);i++)walk(i+1,[...cur,arr[i]]);};walk(0,[]);return out;
};
function scoreFive(cards){
  const nums=cards.map(c=>val(c.rank)).sort((a,b)=>b-a);
  const counts={}; nums.forEach(n=>counts[n]=(counts[n]||0)+1);
  const groups=Object.entries(counts).map(([n,c])=>({n:+n,c})).sort((a,b)=>b.c-a.c||b.n-a.n);
  const flush=cards.every(c=>c.suit===cards[0].suit);
  const unique=[...new Set(nums)].sort((a,b)=>b-a);
  let straight=0;
  if(unique.length===5){if(unique[0]-unique[4]===4)straight=unique[0];else if(unique.join(",")==="14,5,4,3,2")straight=5;}
  if(flush&&straight)return [8,straight];
  if(groups[0].c===4)return [7,groups[0].n,groups[1].n];
  if(groups[0].c===3&&groups[1].c===2)return [6,groups[0].n,groups[1].n];
  if(flush)return [5,...nums];
  if(straight)return [4,straight];
  if(groups[0].c===3)return [3,groups[0].n,...groups.slice(1).map(g=>g.n)];
  if(groups[0].c===2&&groups[1].c===2)return [2,Math.max(groups[0].n,groups[1].n),Math.min(groups[0].n,groups[1].n),groups[2].n];
  if(groups[0].c===2)return [1,groups[0].n,...groups.slice(1).map(g=>g.n)];
  return [0,...nums];
}
function bestScore(player,board,game){
  let best=null;
  const all = game==="omaha"
    ? combinations(player.cards,2).flatMap(h=>combinations(board,3).map(b=>[...h,...b]))
    : combinations([...player.cards,...board],5);
  for(const c of all){const s=scoreFive(c);if(!best||compare(s,best)>0)best=s;}
  return best||[0];
}
function compare(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]||0,y=b[i]||0;if(x!==y)return x-y;}return 0;}
const active = r => r.players.filter(p=>!p.folded);
const canAct = p => p&&!p.folded&&!p.allIn;
function publicRoom(r,viewer){
  const me=r.players.find(p=>p.id===viewer);
  return {id:r.id,name:r.name,game:r.game,smallBlind:r.smallBlind,bigBlind:r.bigBlind,maxPlayers:r.maxPlayers,
    status:r.status,phase:r.phase,pot:r.pot,currentBet:r.currentBet,board:r.board,
    message:r.message,turnId:r.turnId,dealerSeat:r.dealerSeat,handNumber:r.handNumber,
    players:r.players.map(p=>({id:p.id,name:p.name,seat:p.seat,chips:p.chips,bet:p.bet,folded:p.folded,
      allIn:p.allIn,isDealer:p.isDealer,isTurn:p.id===r.turnId,
      cards:(p.id===viewer||r.phase==="showdown"||p.folded)?p.cards:[null,null]})),
    myId:viewer,myCards:me?me.cards:[]};
}
function sendRoom(r){for(const p of r.players)io.to(p.id).emit("table:update",publicRoom(r,p.id));}
function lobby(){
  return TABLES.map(t=>{const r=rooms.get(t.id);return {...t,players:r.players.length,occupiedSeats:r.players.map(p=>p.seat),status:r.status};});
}
function broadcastLobby(){io.emit("lobby:update",lobby());}
function notify(s,msg){s.emit("notice",msg);}
function take(p,n){const x=Math.max(0,Math.min(p.chips,n));p.chips-=x;p.bet+=x;p.totalBet+=x;if(p.chips===0)p.allIn=true;return x;}
function nextPlayer(r,seat,pred){for(let i=1;i<=r.maxPlayers;i++){const s=(seat+i)%r.maxPlayers;const p=r.players.find(x=>x.seat===s);if(p&&pred(p))return p;}return null;}
function setTurn(r,p){r.turnId=p?p.id:null;}
function roomInit(t){return {...t,players:[],board:[],deck:[],pot:0,currentBet:0,phase:"waiting",status:"waiting",turnId:null,dealerSeat:-1,handNumber:0,message:"Тоглогчид ширээнд сууж байна."};}
TABLES.forEach(t=>rooms.set(t.id,roomInit(t)));

function startHand(r){
  if(r.players.filter(p=>p.chips>0).length<2){r.phase="waiting";r.status="waiting";r.message="Тоглолт эхлэхэд 2-оос доошгүй тоглогч хэрэгтэй.";sendRoom(r);return;}
  r.handNumber++;r.deck=deckNew();r.board=[];r.pot=0;r.currentBet=0;r.phase="preflop";r.status="playing";
  r.players.forEach(p=>{p.cards=[];p.bet=0;p.totalBet=0;p.folded=p.chips<=0;p.allIn=false;});
  const dealer=nextPlayer(r,r.dealerSeat,p=>p.chips>0)||r.players.find(p=>p.chips>0);
  r.dealerSeat=dealer.seat;r.players.forEach(p=>p.isDealer=p.seat===r.dealerSeat);
  const holeCount=r.game==="omaha"?4:2;
  r.players.filter(p=>!p.folded).forEach(p=>{for(let i=0;i<holeCount;i++)p.cards.push(r.deck.pop());});
  const sb=nextPlayer(r,r.dealerSeat,p=>!p.folded);
  const bb=sb?nextPlayer(r,sb.seat,p=>!p.folded):null;
  if(sb)take(sb,r.smallBlind);if(bb)take(bb,r.bigBlind);
  r.currentBet=Math.max(0,...r.players.map(p=>p.bet));r.pot=r.players.reduce((a,p)=>a+p.bet,0);
  r.players.forEach(p=>p.acted=false);
  setTurn(r,bb?nextPlayer(r,bb.seat,canAct):null);
  r.message=`Гар ${r.handNumber} эхэллээ`;
  if(!r.turnId)advance(r);
  sendRoom(r);
}
function awardUncontested(r){
  const winner=active(r)[0];if(!winner)return;
  winner.chips+=r.pot;r.message=`${winner.name} ${r.pot.toLocaleString()} чип хожлоо!`;
  r.pot=0;r.phase="showdown";r.status="showdown";setTurn(r,null);
}
function showdown(r){
  const contenders=active(r);
  if(contenders.length===1){awardUncontested(r);sendRoom(r);return;}
  const ranked=contenders.map(p=>({p,score:bestScore(p,r.board,r.game)})).sort((a,b)=>compare(b.score,a.score));
  const winners=ranked.filter(x=>compare(x.score,ranked[0].score)===0).map(x=>x.p);
  const share=Math.floor(r.pot/winners.length);
  winners.forEach(p=>p.chips+=share);
  r.message=`Ялагч: ${winners.map(p=>p.name).join(", ")} — ${share.toLocaleString()} чип`;
  r.pot=0;r.phase="showdown";r.status="showdown";setTurn(r,null);
}
function roundDone(r){return r.players.filter(p=>!p.folded&&!p.allIn).every(p=>p.acted&&p.bet===r.currentBet);}
function advance(r){
  if(active(r).length===1){awardUncontested(r);sendRoom(r);return;}
  if(roundDone(r)){
    r.players.forEach(p=>p.acted=false);
    r.players.forEach(p=>p.bet=0);r.currentBet=0;
    if(r.phase==="preflop"){r.board.push(r.deck.pop(),r.deck.pop(),r.deck.pop());r.phase="flop";}
    else if(r.phase==="flop"){r.board.push(r.deck.pop());r.phase="turn";}
    else if(r.phase==="turn"){r.board.push(r.deck.pop());r.phase="river";}
    else if(r.phase==="river"){showdown(r);sendRoom(r);return;}
    if(r.players.every(p=>p.folded||p.allIn)){while(r.board.length<5)r.board.push(r.deck.pop());showdown(r);sendRoom(r);return;}
    const first=nextPlayer(r,r.dealerSeat,canAct);setTurn(r,first);
    r.message=`${r.phase.toUpperCase()} үе`;sendRoom(r);return;
  }
  const current=r.players.find(p=>p.id===r.turnId);
  const next=current?nextPlayer(r,current.seat,canAct):nextPlayer(r,r.dealerSeat,canAct);
  setTurn(r,next);sendRoom(r);
}
function action(socket,kind,amount){
  const r=rooms.get(socketRooms.get(socket.id));if(!r||r.status!=="playing")return;
  const p=r.players.find(x=>x.id===socket.id);
  if(!p||r.turnId!==socket.id||!canAct(p)){notify(socket,"Таны ээлж биш байна.");return;}
  const toCall=Math.max(0,r.currentBet-p.bet);
  if(kind==="fold"){p.folded=true;p.acted=true;}
  else if(kind==="check"){if(toCall>0){notify(socket,"Check хийх боломжгүй. Call эсвэл Fold сонго.");return;}p.acted=true;}
  else if(kind==="call"){take(p,toCall);p.acted=true;}
  else if(kind==="raise"){
    const target=Math.floor(Number(amount));
    if(!Number.isFinite(target)||target<r.currentBet+r.bigBlind){notify(socket,`Raise хамгийн багадаа ${(r.currentBet+r.bigBlind).toLocaleString()} болгоно.`);return;}
    const need=target-p.bet;if(need>p.chips){notify(socket,"Чип хүрэлцэхгүй байна.");return;}
    const old=r.currentBet;take(p,need);r.currentBet=p.bet;
    if(r.currentBet-old>=r.bigBlind){r.players.forEach(x=>{if(x.id!==p.id&&!x.folded&&!x.allIn)x.acted=false;});}
    p.acted=true;
  } else {return;}
  r.pot=r.players.reduce((a,x)=>a+x.totalBet,0);
  if(active(r).length===1){awardUncontested(r);sendRoom(r);return;}
  advance(r);
}
function removeSocket(socket){
  const tableId=socketRooms.get(socket.id);if(!tableId)return;
  const r=rooms.get(tableId);socketRooms.delete(socket.id);
  if(!r)return;
  const p=r.players.find(x=>x.id===socket.id);
  if(p&&r.status==="playing"){p.folded=true;p.acted=true; if(r.turnId===socket.id)setTurn(r,nextPlayer(r,p.seat,canAct));}
  r.players=r.players.filter(x=>x.id!==socket.id);
  if(r.players.length===0){r.phase="waiting";r.status="waiting";r.pot=0;r.board=[];}
  else if(r.status==="playing"){if(active(r).length===1)awardUncontested(r);else if(r.turnId===null)advance(r);}
  sendRoom(r);broadcastLobby();
}
app.get("/",(req,res)=>res.send("BLACKCLUB ONLINE SERVER IS RUNNING"));
app.get("/api/rooms",(req,res)=>res.json(lobby()));

io.on("connection",socket=>{
  socket.emit("lobby:update",lobby());
  socket.on("lobby:get",cb=>cb&&cb(lobby()));
  socket.on("table:join",(data,cb)=>{
    if(socketRooms.has(socket.id))return cb&&cb({success:false,message:"Та аль хэдийн ширээнд суусан байна."});
    const r=rooms.get(String(data&&data.tableId||""));
    if(!r)return cb&&cb({success:false,message:"Ширээ олдсонгүй."});
    if(r.status==="playing")return cb&&cb({success:false,message:"Энэ ширээний тоглолт эхэлсэн байна. Дараагийн гар эхлэхэд сууна."});
    if(r.players.length>=r.maxPlayers)return cb&&cb({success:false,message:"Ширээ дүүрсэн байна."});
    const seat=Number(data.seat);
    if(!Number.isInteger(seat)||seat<0||seat>=r.maxPlayers||r.players.some(p=>p.seat===seat))return cb&&cb({success:false,message:"Энэ суудал эзэнтэй байна."});
    const player={id:socket.id,name:String(data.name||"Player").slice(0,18),seat,chips:10000,bet:0,totalBet:0,cards:[],folded:false,allIn:false,acted:false};
    r.players.push(player);r.players.sort((a,b)=>a.seat-b.seat);socket.join(r.id);socketRooms.set(socket.id,r.id);
    cb&&cb({success:true,table:publicRoom(r,socket.id)});sendRoom(r);broadcastLobby();
    if(r.players.length>=2&&r.status!=="playing")startHand(r);
  });
  socket.on("table:leave",()=>removeSocket(socket));
  socket.on("game:action",data=>action(socket,data&&data.action,data&&data.amount));
  socket.on("game:next",()=>{
    const r=rooms.get(socketRooms.get(socket.id));if(!r||r.status!=="showdown")return;
    if(r.players.length>=2)startHand(r);
  });
  socket.on("disconnect",()=>removeSocket(socket));
});
server.listen(PORT,"0.0.0.0",()=>console.log(`BLACKCLUB server running on ${PORT}`));
