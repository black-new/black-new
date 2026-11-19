const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const MIN_DEPOSIT = Math.max(5000, Number(process.env.MIN_DEPOSIT || 5000));
const MIN_WITHDRAW = Math.max(10000, Number(process.env.MIN_WITHDRAW || 10000));
const DEFAULT_RAKE_PERCENT = Math.min(10, Math.max(0, Number(process.env.RAKE_PERCENT || 3)));
const DEFAULT_RAKE_CAP_BB = Math.max(0, Number(process.env.RAKE_CAP_BB || 3));
const DEFAULT_JACKPOT_RAKE_PERCENT = Math.min(10, Math.max(0, Number(process.env.JACKPOT_RAKE_PERCENT || 0.5)));
const casinoSettings = { rakePercent: DEFAULT_RAKE_PERCENT, rakeCapBB: DEFAULT_RAKE_CAP_BB, jackpotRakePercent: DEFAULT_JACKPOT_RAKE_PERCENT };
const chatSettings = { enabled: true, modes: ["table", "global", "support"] };
const chatRate = new Map();
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "";
const ADMIN_UIDS = (process.env.ADMIN_UIDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const BANK_INFO = {
  name: process.env.BANK_NAME || "",
  account: process.env.BANK_ACCOUNT || "",
  holder: process.env.BANK_HOLDER || ""
};

const ALLOWED_BANKS = [
  "Хаан банк",
  "Худалдаа хөгжлийн банк",
  "ХасБанк",
  "Төрийн банк",
  "Голомт банк",
  "Капитрон банк",
  "M Bank",
  "Богд банк"
];

// ==========================================
// FIREBASE
// ==========================================

if (!admin.apps.length) {
  const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccountText) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT тохируулаагүй байна.");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(serviceAccountText);
  } catch (error) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT JSON буруу байна.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
db.collection("casinoSettings").doc("main").get().then(snap => { if (snap.exists) { const v=snap.data()||{}; for (const k of ["rakePercent","rakeCapBB","jackpotRakePercent"]) if (Number.isFinite(Number(v[k]))) casinoSettings[k]=Number(v[k]); if (typeof v.chatEnabled === "boolean") chatSettings.enabled=v.chatEnabled; } }).catch(err=>console.error("Casino settings load:",err));

// ==========================================
// COMMON HELPERS
// ==========================================

function makeEmail(username) {
  return String(username).trim().toLowerCase() + "@blackclub.local";
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(String(username || ""));
}

function validAmount(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

function cleanUser(data, uid) {
  return {
    uid: uid || data.uid,
    username: data.username || "",
    displayName: data.displayName || data.username || "",
    chips: Number(data.chips || 0),
    role: data.role || "user",
    isAdmin: data.role === "admin" || !!data.isAdmin || ADMIN_UIDS.includes(String(uid || data.uid || "")),
    bankName: data.bankName || "",
    bankAccount: data.bankAccount || "",
    bankHolder: data.bankHolder || "",
    ageConfirmed: data.ageConfirmed === true,
    blocked: data.blocked === true,
    chatMuted: data.chatMuted === true
  };
}

async function firebaseRequest(endpoint, body) {
  if (!FIREBASE_WEB_API_KEY) {
    throw new Error("FIREBASE_WEB_API_KEY тохируулаагүй байна.");
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    const code = result?.error?.message || "AUTH_ERROR";

    const messages = {
      EMAIL_EXISTS: "Энэ хэрэглэгчийн нэр бүртгэлтэй байна.",
      INVALID_PASSWORD: "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна.",
      EMAIL_NOT_FOUND: "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна.",
      INVALID_LOGIN_CREDENTIALS: "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна.",
      WEAK_PASSWORD: "Нууц үг дор хаяж 6 тэмдэгт байх ёстой.",
      USER_DISABLED: "Энэ бүртгэл идэвхгүй байна."
    };

    throw new Error(messages[code] || "Нэвтрэлт амжилтгүй боллоо.");
  }

  return result;
}

async function authUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ message: "Нэвтрэх шаардлагатай." });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const userRef = db.collection("users").doc(decoded.uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(401).json({ message: "Хэрэглэгч олдсонгүй." });
    }

    req.user = {
      ...snap.data(),
      uid: decoded.uid
    };

    if (snap.data().blocked === true) return res.status(403).json({ message: "Энэ бүртгэлийг админ түр хаасан байна." });

    req.userRef = userRef;
    next();
  } catch (error) {
    return res.status(401).json({
      message: "Нэвтрэх эрх хүчингүй эсвэл хугацаа дууссан байна."
    });
  }
}

function authAdmin(req, res, next) {
  if (
    !ADMIN_UIDS.includes(req.user.uid) &&
    req.user.role !== "admin" &&
    req.user.isAdmin !== true
  ) {
    return res.status(403).json({ message: "Админ эрх шаардлагатай." });
  }

  next();
}

// ==========================================
// TOURNAMENTS: lobby, registration, admin controls and idempotent payouts
// ==========================================
app.get("/api/tournaments", authUser, async (req,res) => {
  try {
    const snap=await db.collection("tournaments").orderBy("createdAt","desc").limit(100).get();
    const tournaments=[];
    for (const d of snap.docs) {
      const v=d.data();
      const mine=await d.ref.collection("participants").doc(req.user.uid).get();
      tournaments.push({id:d.id,name:v.name,description:v.description||"",mode:v.mode,entryFee:Number(v.entryFee||0),maxPlayers:Number(v.maxPlayers||0),startAt:v.startAt||null,registrationDeadline:v.registrationDeadline||null,status:v.status,prizes:v.prizes||[],prizeMode:v.prizeMode||"fixed",prizePercentages:v.prizePercentages||[],organizerPercent:Number(v.organizerPercent||0),reservePercent:Number(v.reservePercent||0),placeCount:Number(v.placeCount||(v.prizes||[]).length||3),participantCount:Number(v.participantCount||0),registered:mine.exists});
    }
    res.json({tournaments});
  } catch(e) { res.status(500).json({message:"Тэмцээний жагсаалт ачаалж чадсангүй."}); }
});
app.post("/api/tournaments/:id/register", authUser, async (req,res) => {
  try {
    const ref=db.collection("tournaments").doc(String(req.params.id||""));
    const result=await db.runTransaction(async tx=>{
      const ts=await tx.get(ref); if(!ts.exists) throw new Error("Тэмцээн олдсонгүй.");
      const t=ts.data(), participant=ref.collection("participants").doc(req.user.uid), ps=await tx.get(participant);
      if(ps.exists) throw new Error("Та аль хэдийн бүртгүүлсэн байна.");
      if(t.status!=="scheduled") throw new Error("Энэ тэмцээний бүртгэл хаалттай байна.");
      if(t.registrationDeadline && Date.now()>new Date(t.registrationDeadline).getTime()) throw new Error("Бүртгэлийн хугацаа дууссан байна.");
      if(Number(t.participantCount||0)>=Number(t.maxPlayers||0)) throw new Error("Оролцогчдын тоо дүүрсэн байна.");
      const fee=Number(t.entryFee||0), userRef=db.collection("users").doc(req.user.uid), us=await tx.get(userRef);
      if(!us.exists) throw new Error("Хэрэглэгч олдсонгүй.");
      const balance=Number(us.data().chips||0); if(balance<fee) { const short=fee-balance; throw new Error(`CHIP хүрэлцэхгүй байна. Шаардлагатай: ${fee.toLocaleString()} CHIP · Үлдэгдэл: ${balance.toLocaleString()} CHIP · Дутуу: ${short.toLocaleString()} CHIP. Касс хэсгээс цэнэглэнэ үү.`); }
      if(fee>0) tx.update(userRef,{chips:balance-fee});
      tx.create(participant,{uid:req.user.uid,username:req.user.username||"",displayName:req.user.displayName||req.user.username||"",entryFee:fee,status:"registered",registeredAt:FieldValue.serverTimestamp()});
      tx.update(ref,{participantCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()});
      if(fee>0) tx.create(db.collection("chipLedger").doc("tourney_entry_"+ref.id+"_"+req.user.uid),{uid:req.user.uid,username:req.user.username||"",type:"tournament_buyin",amount:-fee,tournamentId:ref.id,createdAt:FieldValue.serverTimestamp()});
      return {fee,balance:balance-fee};
    });
    res.json({success:true,message:"Тэмцээнд амжилттай бүртгүүллээ.",...result});
  } catch(e) { res.status(400).json({message:e.message||"Бүртгүүлэхэд алдаа гарлаа."}); }
});
app.post("/api/admin/tournaments", authUser, authAdmin, async (req,res) => {
  try {
    const name=String(req.body.name||"").trim(), mode=String(req.body.mode||"FREE").toUpperCase();
    const entryFee=validAmount(req.body.entryFee)||0, maxPlayers=Number(req.body.maxPlayers||0);
    const startAt=String(req.body.startAt||""), deadline=String(req.body.registrationDeadline||"");
    const placeCount=Number(req.body.placeCount||0);
    if(name.length<3||name.length>70||!['FREE','BUYIN'].includes(mode)||!Number.isInteger(maxPlayers)||maxPlayers<2||maxPlayers>500||!startAt||!Number.isFinite(new Date(startAt).getTime())||!deadline||!Number.isFinite(new Date(deadline).getTime())||new Date(deadline)>=new Date(startAt)) return res.status(400).json({message:"Тэмцээний мэдээлэл буруу байна."});
    if(mode==='FREE'&&entryFee!==0) return res.status(400).json({message:"FREE тэмцээн CHIP төлбөргүй байна."});
    if(mode==='BUYIN'&&entryFee<1) return res.status(400).json({message:"BUY-IN тэмцээний CHIP төлбөр оруулна уу."});
    if(!Number.isInteger(placeCount)||placeCount<1||placeCount>10) return res.status(400).json({message:"Шагналын байр 1–10 хооронд байна."});
    let prizes=[], prizePercentages=[], organizerPercent=0, reservePercent=0;
    if(mode==='FREE') {
      prizes=(Array.isArray(req.body.prizes)?req.body.prizes:[]).slice(0,placeCount).map(validAmount);
      if(prizes.length!==placeCount||prizes.some(x=>!Number.isSafeInteger(x)||x<0)||!prizes.some(x=>x>0)||prizes.reduce((a,b)=>a+b,0)>1000000000) return res.status(400).json({message:"FREE тэмцээний байр тус бүрийн CHIP шагналыг зөв оруулна уу."});
    } else {
      prizePercentages=(Array.isArray(req.body.prizePercentages)?req.body.prizePercentages:[]).slice(0,placeCount).map(Number);
      organizerPercent=Number(req.body.organizerPercent||0); reservePercent=Number(req.body.reservePercent||0);
      const all=[...prizePercentages,organizerPercent,reservePercent];
      if(prizePercentages.length!==placeCount||all.some(x=>!Number.isFinite(x)||x<0||x>100)||Math.abs(all.reduce((a,b)=>a+b,0)-100)>0.000001||!prizePercentages.some(x=>x>0)) return res.status(400).json({message:"Шагнал, зохион байгуулагч, нөөцийн хувь нийлээд яг 100% байх ёстой."});
    }
    const ref=db.collection("tournaments").doc();
    await ref.set({name,description:String(req.body.description||"").slice(0,500),mode,entryFee,maxPlayers,startAt,registrationDeadline:deadline,placeCount,prizeMode:mode==='BUYIN'?'percentage':'fixed',prizes,prizePercentages,organizerPercent,reservePercent,status:"scheduled",participantCount:0,createdBy:req.user.uid,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
    res.json({success:true,id:ref.id,message:"Тэмцээн үүслээ."});
  } catch(e) { res.status(500).json({message:e.message||"Тэмцээн үүсгэхэд алдаа гарлаа."}); }
});
app.get("/api/admin/tournaments/:id/participants", authUser, authAdmin, async (req,res) => {
  try { const snap=await db.collection("tournaments").doc(String(req.params.id||"")).collection("participants").orderBy("registeredAt","asc").limit(500).get(); res.json({participants:snap.docs.map(d=>({uid:d.id,...d.data()}))}); } catch(e) { res.status(500).json({message:"Оролцогчдын жагсаалт ачаалж чадсангүй."}); }
});
app.post("/api/admin/tournaments/:id/status", authUser, authAdmin, async (req,res) => {
  try {
    const status=String(req.body.status||""); if(!["scheduled","live","paused","cancelled"].includes(status)) return res.status(400).json({message:"Төлөв буруу байна."});
    const ref=db.collection("tournaments").doc(String(req.params.id||""));
    await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error("Тэмцээн олдсонгүй.");if(["completed","cancelled"].includes(snap.data().status))throw new Error("Дууссан эсвэл цуцалсан тэмцээний төлөв өөрчлөхгүй.");if(status==="cancelled"&&Number(snap.data().entryFee||0)>0&&Number(snap.data().participantCount||0)>0)throw new Error("BUY-IN оролцогчтой тэмцээнийг одоогоор шууд цуцлахгүй. CHIP буцаалтын ажиллагаа шаардлагатай.");tx.update(ref,{status,updatedAt:FieldValue.serverTimestamp(),statusUpdatedBy:req.user.uid});});
    res.json({success:true,message:"Тэмцээний төлөв шинэчлэгдлээ."});
  } catch(e) { res.status(400).json({message:e.message||"Төлөв өөрчлөхөд алдаа гарлаа."}); }
});
app.post("/api/admin/tournaments/:id/settle", authUser, authAdmin, async (req,res) => {
  try {
    const winners=Array.isArray(req.body.winners)?req.body.winners.slice(0,10):[];
    if(!winners.length||new Set(winners.map(w=>w&&w.uid)).size!==winners.length||winners.some(w=>!w||typeof w.uid!=="string"||!w.uid.trim())) return res.status(400).json({message:"Ялагч бүрийг зөв сонгоно уу."});
    const ref=db.collection("tournaments").doc(String(req.params.id||""));
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);if(!snap.exists)throw new Error("Тэмцээн олдсонгүй.");const t=snap.data();
      if(t.status==="completed"||t.payoutCompleted===true)throw new Error("Шагналыг өмнө нь олгосон байна.");
      if(t.status!=="live"&&t.status!=="paused")throw new Error("Зөвхөн эхэлсэн тэмцээнийг дүгнэнэ.");
      const placeCount=Number(t.placeCount||((t.prizes||[]).length)||3);
      if(winners.length>placeCount)throw new Error("Тохируулсан шагналын байрнаас олон ялагч сонгосон байна.");
      const participantRefs=winners.map(w=>ref.collection("participants").doc(w.uid));
      const userRefs=winners.map(w=>db.collection("users").doc(w.uid));
      const participantSnaps=[];for(const pr of participantRefs)participantSnaps.push(await tx.get(pr));
      const userSnaps=[];for(const ur of userRefs)userSnaps.push(await tx.get(ur));
      if(participantSnaps.some(x=>!x.exists))throw new Error("Ялагчдын нэг нь бүртгэлтэй оролцогч биш байна.");
      if(userSnaps.some(x=>!x.exists))throw new Error("Ялагчийн данс олдсонгүй.");
      let amounts=[];let organizerAmount=0;let reserveAmount=0;
      if(t.mode==="BUYIN" && t.prizeMode==="percentage") {
        const pool=Number(t.participantCount||0)*Number(t.entryFee||0), percents=t.prizePercentages||[];
        amounts=winners.map((w,i)=>Math.floor(pool*Number(percents[i]||0)/100));
        organizerAmount=Math.floor(pool*Number(t.organizerPercent||0)/100);
        reserveAmount=pool-amounts.reduce((a,b)=>a+b,0)-organizerAmount;
        if(reserveAmount<0)throw new Error("Шагналын хувь буруу байна.");
      } else {
        const fixed=Array.isArray(t.prizes)?t.prizes:[];
        amounts=winners.map((w,i)=>Number(fixed[i]||0));
        if(amounts.some((a,i)=>a!==Number(fixed[i]||0)))throw new Error("Тогтмол шагналын тохиргоо зөрсөн байна.");
      }
      const creatorRef=db.collection("users").doc(String(t.createdBy||""));
      let creatorSnap=null;
      if(organizerAmount>0){creatorSnap=await tx.get(creatorRef);if(!creatorSnap.exists)throw new Error("Зохион байгуулагчийн данс олдсонгүй.");}
      winners.forEach((w,i)=>{
        const amount=amounts[i];
        tx.update(participantRefs[i],{place:i+1,prize:amount,status:"winner"});
        if(amount>0){tx.update(userRefs[i],{chips:FieldValue.increment(amount)});tx.create(db.collection("chipLedger").doc("tourney_prize_"+ref.id+"_"+w.uid),{uid:w.uid,type:"tournament_prize",amount,tournamentId:ref.id,place:i+1,createdAt:FieldValue.serverTimestamp()});}
      });
      if(organizerAmount>0){tx.update(creatorRef,{chips:FieldValue.increment(organizerAmount)});tx.create(db.collection("chipLedger").doc("tourney_organizer_"+ref.id),{uid:t.createdBy,type:"tournament_organizer_share",amount:organizerAmount,tournamentId:ref.id,createdAt:FieldValue.serverTimestamp()});}
      tx.update(ref,{status:"completed",payoutCompleted:true,winners:winners.map((w,i)=>({uid:w.uid,place:i+1,amount:amounts[i]})),organizerAmount,reserveAmount,prizePool:Number(t.participantCount||0)*Number(t.entryFee||0),completedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
    });
    res.json({success:true,message:"Тэмцээн дуусаж, тохируулсан шагналууд CHIP хэлбэрээр олгогдлоо."});
  } catch(e) { res.status(400).json({message:e.message||"Шагнал олгоход алдаа гарлаа."}); }
});

app.get("/api/history/hands", authUser, async (req, res) => {
  try {
    const snap = await db.collection("handHistory").orderBy("createdAt", "desc").limit(100).get();
    const hands = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(h => (h.players || []).some(p => p.uid === req.user.uid));
    res.json({ hands: hands.slice(0, 50) });
  } catch (error) { res.status(500).json({ message: "Гарын түүх уншиж чадсангүй." }); }
});

// ==========================================
// CASINO RAKE / JACKPOT SETTINGS & REPORTS
// ==========================================
app.get("/api/casino/pools", authUser, async (req, res) => {
  try {
    const snap = await db.collection("casinoStats").doc("global").get();
    const data = snap.exists ? (snap.data() || {}) : {};
    res.json({ jackpotPool: Number(data.jackpotPool || 0), updatedAt: data.updatedAt || null });
  } catch (error) {
    res.status(500).json({ message: "Шагналын сангийн мэдээлэл уншиж чадсангүй." });
  }
});

app.get("/api/admin/casino/settings", authUser, authAdmin, (req, res) => {
  res.json({ settings: { ...casinoSettings } });
});
app.post("/api/admin/casino/settings", authUser, authAdmin, async (req, res) => {
  try {
    const rakePercent = Number(req.body?.rakePercent);
    const rakeCapBB = Number(req.body?.rakeCapBB);
    const jackpotRakePercent = Number(req.body?.jackpotRakePercent);
    if (![rakePercent, rakeCapBB, jackpotRakePercent].every(Number.isFinite) || rakePercent < 0 || rakePercent > 10 || rakeCapBB < 0 || rakeCapBB > 20 || jackpotRakePercent < 0 || jackpotRakePercent > 10) {
      return res.status(400).json({ message: "Rake тохиргооны утга буруу байна." });
    }
    Object.assign(casinoSettings, { rakePercent, rakeCapBB, jackpotRakePercent });
    await db.collection("casinoSettings").doc("main").set({ ...casinoSettings, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user.uid }, { merge: true });
    res.json({ ok: true, settings: { ...casinoSettings } });
  } catch (error) { res.status(500).json({ message: "Тохиргоо хадгалж чадсангүй." }); }
});
// ADMIN CHAT CONTROLS: chat on/off, user mute/unmute, and account display settings.
app.get("/api/chat/settings", authUser, async (req,res) => {
  try { const snap=await db.collection("casinoSettings").doc("main").get(); const v=snap.data()||{}; res.json({enabled:chatSettings.enabled, bank:{name:v.bankName||BANK_INFO.name,account:v.bankAccount||BANK_INFO.account,holder:v.bankHolder||BANK_INFO.holder}}); }
  catch(e){res.status(500).json({message:"Чатын тохиргоо уншиж чадсангүй."});}
});
app.post("/api/admin/chat/settings", authUser, authAdmin, async (req,res) => {
  try {
    const enabled=req.body?.enabled;
    if(typeof enabled!=="boolean") return res.status(400).json({message:"Chat төлөв буруу байна."});
    chatSettings.enabled=enabled;
    // Зөвхөн чатны төлөвийг хадгална. Банкны өмнөх тохиргоонд хүрэхгүй.
    await db.collection("casinoSettings").doc("main").set({chatEnabled:enabled,chatUpdatedAt:FieldValue.serverTimestamp(),chatUpdatedBy:req.user.uid},{merge:true});
    io.emit("chat:settings",{enabled});
    res.json({ok:true,enabled});
  } catch(e){res.status(500).json({message:"Чатын тохиргоо хадгалж чадсангүй."});}
});
app.post("/api/admin/chat/mute", authUser, authAdmin, async (req,res) => {
  try {
    const uid=String(req.body?.uid||"").trim(), muted=req.body?.muted;
    if(!uid||typeof muted!=="boolean") return res.status(400).json({message:"Хэрэглэгч эсвэл төлөв буруу байна."});
    if(ADMIN_UIDS.includes(uid)) return res.status(403).json({message:"Админыг энэ аргаар mute хийхгүй."});
    await db.collection("users").doc(uid).set({chatMuted:muted,chatMutedBy:req.user.uid,chatMutedAt:FieldValue.serverTimestamp()},{merge:true});
    res.json({ok:true,muted});
  } catch(e){res.status(500).json({message:"Chat эрх өөрчилж чадсангүй."});}
});

app.get("/api/admin/casino/report", authUser, authAdmin, async (req, res) => {
  try {
    const snap = await db.collection("rakeLedger").orderBy("createdAt", "desc").limit(200).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const totalRake = rows.reduce((n, x) => n + Number(x.rake || 0), 0);
    const totalJackpot = rows.reduce((n, x) => n + Number(x.jackpotContribution || 0), 0);
    res.json({ totalRake, totalJackpot, rows });
  } catch (error) { res.status(500).json({ message: "Rake тайлан уншиж чадсангүй." }); }
});

function publicRequest(data) {
  return {
    id: data.id,
    type: data.type,
    amount: data.amount,
    username: data.username || "",
    displayName: data.displayName || "",
    bankName: data.bankName || "",
    bankAccount: data.bankAccount || "",
    bankHolder: data.bankHolder || "",
    reference: data.reference || "",
    status: data.status || "pending",
    adminNote: data.adminNote || "",
    createdAt: data.createdAt || null
  };
}

// ==========================================
// REGISTER
// Шинэ бүртгэлд банкны мэдээлэл + 18+ зөвшөөрөл шаардана.
// Өмнөх хэрэглэгчдийн login болон CHIP мэдээлэлд хүрэхгүй.
// ==========================================

app.post("/api/register", async (req, res) => {
  let createdUid = null;

  try {
    const username = normalizeUsername(req.body.username);
    const displayName = String(req.body.displayName || username).trim();
    const password = String(req.body.password || "");
    const bankName = String(req.body.bankName || "").trim();
    const bankAccount = String(req.body.bankAccount || "").trim();
    const bankHolder = String(req.body.bankHolder || "").trim();
    const ageConfirmed = req.body.ageConfirmed === true;

    if (!validUsername(username)) {
      return res.status(400).json({
        message: "Хэрэглэгчийн нэр 3-20 тэмдэгт байх ёстой. Англи үсэг, тоо, _ ашиглана."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Нууц үг дор хаяж 6 тэмдэгт байх ёстой."
      });
    }

    if (!ALLOWED_BANKS.includes(bankName)) {
      return res.status(400).json({
        message: "Жагсаалтаас банк сонгоно уу."
      });
    }

    if (!/^[0-9]{6,20}$/.test(bankAccount)) {
      return res.status(400).json({
        message: "Дансны дугаар 6-20 оронтой тоо байх ёстой."
      });
    }

    if (bankHolder.length < 2 || bankHolder.length > 60) {
      return res.status(400).json({
        message: "Данс эзэмшигчийн нэрийг зөв оруулна уу."
      });
    }

    if (!ageConfirmed) {
      return res.status(400).json({
        message: "18 нас хүрсэн гэдгээ баталгаажуулна уу."
      });
    }

    const usernameRef = db.collection("usernames").doc(username);
    const existingUsername = await usernameRef.get();

    if (existingUsername.exists) {
      return res.status(409).json({
        message: "Энэ хэрэглэгчийн нэр бүртгэлтэй байна."
      });
    }

    // Хуучин хувилбартай ижил Firebase email namespace-г ашиглана.
    // Ингэснээр өмнөх хэрэглэгчдийн нэвтрэх мэдээлэл өөрчлөгдөхгүй.
    const account = await firebaseRequest("accounts:signUp", {
      email: makeEmail(username),
      password,
      returnSecureToken: true
    });

    const uid = account.localId;
    createdUid = uid;

    const userData = {
      username,
      displayName: displayName || username,
      chips: 0,
      role: "user",
      isAdmin: false,
      bankName,
      bankAccount,
      bankHolder,
      ageConfirmed: true,
      ageConfirmedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp()
    };

    // Давхар бүртгэлийн race нөхцөлөөс хамгаалж username + user-ийг
    // нэг Firestore transaction дотор хадгална.
    await db.runTransaction(async transaction => {
      const nameSnap = await transaction.get(usernameRef);

      if (nameSnap.exists) {
        throw new Error("Энэ хэрэглэгчийн нэр бүртгэлтэй байна.");
      }

      const userRef = db.collection("users").doc(uid);
      const userSnap = await transaction.get(userRef);

      if (userSnap.exists) {
        throw new Error("Хэрэглэгчийн бүртгэл аль хэдийн байна.");
      }

      transaction.set(usernameRef, { uid });
      transaction.set(userRef, userData);
    });

    createdUid = null;

    return res.json({
      success: true,
      token: account.idToken,
      refreshToken: account.refreshToken,
      user: cleanUser(userData, uid)
    });

  } catch (error) {
    // Firebase хэрэглэгч үүссэн ч Firestore хадгалалт бүтэлгүйтвэл
    // дутуу бүртгэл үлдээхгүйн тулд зөвхөн шинээр үүсгэсэн UID-г устгана.
    if (createdUid) {
      try {
        await admin.auth().deleteUser(createdUid);
      } catch (rollbackError) {
        console.error("REGISTER ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("REGISTER ERROR:", error);

    return res.status(400).json({
      message: error.message || "Бүртгэл үүсгэхэд алдаа гарлаа."
    });
  }
});

// ==========================================
// LOGIN — ХУУЧИН БОЛОН ШИНЭ ХЭРЭГЛЭГЧИД
// Зөвхөн хэрэглэгчийн нэр + нууц үг.
// ==========================================

app.post("/api/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        message: "Хэрэглэгчийн нэр, нууц үгээ оруулна уу."
      });
    }

    const account = await firebaseRequest(
      "accounts:signInWithPassword",
      {
        email: makeEmail(username),
        password,
        returnSecureToken: true
      }
    );

    const userRef = db.collection("users").doc(account.localId);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(401).json({
        message: "Хэрэглэгчийн мэдээлэл олдсонгүй."
      });
    }

    // Хуучин user document-ийн CHIP болон бусад утгыг өөрчлөхгүй.
    const user = cleanUser(snap.data(), account.localId);

    return res.json({
      success: true,
      token: account.idToken,
      refreshToken: account.refreshToken,
      user
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(401).json({
      message: error.message || "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна."
    });
  }
});

// ==========================================
// CURRENT USER
// ==========================================

app.get("/api/me", authUser, (req, res) => {
  res.json({
    user: cleanUser(req.user, req.user.uid)
  });
});

// ==========================================
// PROFILE UPDATE
// ==========================================

app.post("/api/profile/update", authUser, async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim();
    const bankName = String(req.body.bankName || "").trim();
    const bankAccount = String(req.body.bankAccount || "").trim();
    const bankHolder = String(req.body.bankHolder || "").trim();

    if (displayName.length > 40) {
      return res.status(400).json({
        message: "Нэр 40 тэмдэгтээс хэтэрч болохгүй."
      });
    }

    await req.userRef.update({
      displayName: displayName || req.user.username,
      bankName,
      bankAccount,
      bankHolder
    });

    const snap = await req.userRef.get();

    res.json({
      success: true,
      user: cleanUser(snap.data(), req.user.uid)
    });

  } catch (error) {
    res.status(500).json({ message: "Мэдээлэл хадгалахад алдаа гарлаа." });
  }
});

// ==========================================
// BANK WEBHOOK: verified incoming transfer -> player CHIP credit
// Configure BANK_WEBHOOK_SECRETS on Render as JSON: {"provider-key":"long-random-secret"}
// Provider must POST signed raw JSON with X-BLACKCLUB-SIGNATURE: hex(HMAC-SHA256(rawBody, secret)).
// Body: {transactionId, accountNumber, amount, description, status:"success", currency:"MNT"}
// ==========================================
function safeEqualHex(a, b) {
  try { const aa=Buffer.from(String(a||""),"hex"), bb=Buffer.from(String(b||""),"hex"); return aa.length===bb.length && aa.length>0 && crypto.timingSafeEqual(aa,bb); }
  catch (_) { return false; }
}
function getBankWebhookSecrets() {
  try { const x=JSON.parse(process.env.BANK_WEBHOOK_SECRETS||"{}"); return x && typeof x==="object" ? x : {}; }
  catch (_) { return {}; }
}
function extractPlayerUsername(description) {
  const text=String(description||"").trim();
  // Accept a username as a standalone token; avoid matching a substring of another word.
  const matches=text.match(/[A-Za-z0-9_]{3,20}/g)||[];
  return matches.length===1 ? matches[0] : "";
}
app.post("/api/bank-webhooks/:bankKey", async (req,res) => {
  try {
    const bankKey=String(req.params.bankKey||"").trim().toLowerCase();
    const secret=getBankWebhookSecrets()[bankKey];
    if(!secret || !req.rawBody) return res.status(404).json({message:"Webhook холболт тохируулаагүй байна."});
    const supplied=String(req.get("x-blackclub-signature")||"").replace(/^sha256=/i,"");
    const expected=crypto.createHmac("sha256",String(secret)).update(req.rawBody).digest("hex");
    if(!safeEqualHex(supplied,expected)) return res.status(401).json({message:"Гарын үсгийн баталгаажуулалт амжилтгүй."});
    const body=req.body||{};
    const transactionId=String(body.transactionId||"").trim();
    const accountNumber=String(body.accountNumber||"").replace(/\s/g,"");
    const amount=validAmount(body.amount);
    const description=String(body.description||"").trim();
    const status=String(body.status||"").toLowerCase();
    const currency=String(body.currency||"MNT").toUpperCase();
    if(!transactionId || transactionId.length>160 || !/^[0-9]{6,20}$/.test(accountNumber) || !amount || amount>100000000 || !description || status!=="success" || currency!=="MNT")
      return res.status(400).json({message:"Гүйлгээний мэдээлэл буруу эсвэл амжилтгүй байна."});
    const accountSnap=await db.collection("paymentAccounts").where("bankAccount","==",accountNumber).limit(10).get();
    const accountDoc=accountSnap.docs.find(d => d.data().active===true || d.data().bankKey===bankKey);
    if(!accountDoc) return res.status(404).json({message:"Хүлээн авах данс BLACKCLUB-д бүртгэлгүй байна."});
    const playerName=extractPlayerUsername(description);
    const txKey=crypto.createHash("sha256").update(bankKey+"|"+transactionId).digest("hex");
    const txRef=db.collection("bankTransactions").doc(txKey);
    const usernameLower=normalizeUsername(playerName);
    let userSnap=null;
    if(playerName) {
      const q=await db.collection("users").where("username","==",playerName).limit(2).get();
      if(!q.empty) userSnap=q.size===1?q.docs[0]:null;
      if(!userSnap) {
        const all=await db.collection("users").limit(5000).get();
        const found=all.docs.filter(d=>normalizeUsername(d.data().username)===usernameLower);
        if(found.length===1) userSnap=found[0];
      }
    }
    let outcome="pending", reason="";
    await db.runTransaction(async t=>{
      const already=await t.get(txRef);
      if(already.exists) { outcome="duplicate"; return; }
      if(!userSnap) {
        reason=playerName?"Тоглогчийн нэр олдсонгүй эсвэл давхардсан.":"Гүйлгээний утгад ганц тоглогчийн нэр олдсонгүй.";
        t.create(txRef,{bankKey,transactionId,accountNumber,amount,description,username:playerName,status:"pending",reason,receivedAt:FieldValue.serverTimestamp()});
        outcome="pending"; return;
      }
      const userRef=userSnap.ref;
      const fresh=await t.get(userRef);
      if(!fresh.exists) { reason="Тоглогчийн бүртгэл олдсонгүй."; t.create(txRef,{bankKey,transactionId,accountNumber,amount,description,username:playerName,status:"pending",reason,receivedAt:FieldValue.serverTimestamp()}); outcome="pending"; return; }
      t.update(userRef,{chips:FieldValue.increment(amount)});
      t.create(txRef,{bankKey,transactionId,accountNumber,amount,description,uid:userRef.id,username:fresh.data().username||playerName,status:"credited",creditedAt:FieldValue.serverTimestamp(),receivedAt:FieldValue.serverTimestamp()});
      const ledgerRef=db.collection("chipLedger").doc(txKey);
      t.create(ledgerRef,{uid:userRef.id,username:fresh.data().username||playerName,type:"deposit",amount,source:"bank_webhook",bankKey,transactionId,createdAt:FieldValue.serverTimestamp()});
      outcome="credited";
    });
    return res.json({success:true,status:outcome,reason:reason||undefined});
  } catch(error) { console.error("BANK WEBHOOK ERROR",error); return res.status(500).json({message:"Гүйлгээг боловсруулахад алдаа гарлаа."}); }
});

// ==========================================
// CASHIER INFO
// ==========================================

app.get("/api/cashier/info", authUser, async (req, res) => {
  try {
    const activeSnap = await db.collection("paymentAccounts").where("active", "==", true).limit(1).get();
    if (!activeSnap.empty) {
      const a = activeSnap.docs[0].data() || {};
      return res.json({ bank:{name:a.bankName||"",account:a.bankAccount||"",holder:a.bankHolder||"",accountId:activeSnap.docs[0].id}, chips:Number(req.user.chips||0), paymentMode:"manual-pending-provider" });
    }
    const snap=await db.collection("casinoSettings").doc("main").get(); const v=snap.data()||{};
    res.json({ bank:{name:v.bankName||BANK_INFO.name,account:v.bankAccount||BANK_INFO.account,holder:v.bankHolder||BANK_INFO.holder}, chips:Number(req.user.chips||0), paymentMode:"manual-pending-provider" });
  } catch(e) { res.status(500).json({message:"Банкны мэдээлэл авахад алдаа гарлаа."}); }
});

// ADMIN: MULTIPLE RECEIVING ACCOUNTS. This manages display/selection only;
// it does not verify bank transfers until an official bank/payment API is connected.
app.get("/api/admin/payment-accounts", authUser, authAdmin, async (req,res) => {
  try {
    const snap = await db.collection("paymentAccounts").orderBy("createdAt", "desc").limit(100).get();
    res.json({ accounts:snap.docs.map(d=>({id:d.id,...d.data()})) });
  } catch(e) { res.status(500).json({message:"Дансны жагсаалт ачаалж чадсангүй."}); }
});
app.post("/api/admin/payment-accounts", authUser, authAdmin, async (req,res) => {
  try {
    const bankName=String(req.body.bankName||"").trim();
    const bankAccount=String(req.body.bankAccount||"").trim();
    const bankHolder=String(req.body.bankHolder||"").trim();
    if(!ALLOWED_BANKS.includes(bankName)) return res.status(400).json({message:"Банкны нэр буруу байна."});
    if(!/^[0-9]{6,20}$/.test(bankAccount)) return res.status(400).json({message:"Дансны дугаар 6-20 оронтой байх ёстой."});
    if(bankHolder.length<2||bankHolder.length>60) return res.status(400).json({message:"Данс эзэмшигчийн нэр буруу байна."});
    const ref=db.collection("paymentAccounts").doc();
    const existing=await db.collection("paymentAccounts").limit(1).get();
    await ref.set({bankName,bankAccount,bankHolder,active:existing.empty,createdAt:FieldValue.serverTimestamp(),createdBy:req.user.uid,ownerConsentConfirmed:req.body.ownerConsentConfirmed===true});
    res.json({success:true,id:ref.id,message:"Данс хадгалагдлаа. Автомат гүйлгээ танихын тулд банкны API холболт шаардлагатай."});
  } catch(e) { res.status(500).json({message:"Данс хадгалах үед алдаа гарлаа."}); }
});
app.post("/api/admin/payment-accounts/active", authUser, authAdmin, async (req,res) => {
  try {
    const id=String(req.body.id||"").trim();
    if(!id) return res.status(400).json({message:"Дансны ID дутуу байна."});
    const selected=db.collection("paymentAccounts").doc(id);
    const selectedSnap=await selected.get();
    if(!selectedSnap.exists) return res.status(404).json({message:"Данс олдсонгүй."});
    const all=await db.collection("paymentAccounts").get();
    const batch=db.batch();
    all.docs.forEach(d=>batch.set(d.ref,{active:d.id===id,updatedAt:FieldValue.serverTimestamp(),updatedBy:req.user.uid},{merge:true}));
    await batch.commit();
    res.json({success:true,message:"Идэвхтэй данс солигдлоо."});
  } catch(e) { res.status(500).json({message:"Идэвхтэй данс солиход алдаа гарлаа."}); }
});
app.post("/api/admin/payment-accounts/delete", authUser, authAdmin, async (req,res) => {
  try {
    const id=String(req.body.id||"").trim();
    if(!id) return res.status(400).json({message:"Дансны ID дутуу байна."});
    const ref=db.collection("paymentAccounts").doc(id), snap=await ref.get();
    if(!snap.exists) return res.status(404).json({message:"Данс олдсонгүй."});
    await ref.delete();
    const remaining=await db.collection("paymentAccounts").get();
    if(!remaining.empty && !remaining.docs.some(d=>d.data().active===true)) await remaining.docs[0].ref.set({active:true},{merge:true});
    res.json({success:true,message:"Данс устгагдлаа."});
  } catch(e) { res.status(500).json({message:"Данс устгахад алдаа гарлаа."}); }
});

// ==========================================
// DEPOSIT REQUEST
// ==========================================

app.post("/api/cashier/deposit", authUser, async (req, res) => {
  try {
    const amount = validAmount(req.body.amount);
    const reference = String(req.body.reference || "").trim();

    if (!amount) {
      return res.status(400).json({ message: "Дүн буруу байна." });
    }

    if (amount < MIN_DEPOSIT) {
      return res.status(400).json({ message: `Цэнэглэх доод хэмжээ ${MIN_DEPOSIT.toLocaleString()} CHIP байна.` });
    }

    if (amount > 100000000) {
      return res.status(400).json({ message: "Дүн хэт их байна." });
    }

    const requestRef = db.collection("cashierRequests").doc();
    const activeAccountSnap = await db.collection("paymentAccounts").where("active", "==", true).limit(1).get();
    const activeAccountDoc = activeAccountSnap.empty ? null : activeAccountSnap.docs[0];
    const activeAccount = activeAccountDoc ? (activeAccountDoc.data() || {}) : {};

    await requestRef.set({
      uid: req.user.uid,
      username: req.user.username,
      displayName: req.user.displayName || req.user.username,
      bankName: activeAccount.bankName || req.user.bankName || "",
      bankAccount: activeAccount.bankAccount || req.user.bankAccount || "",
      bankHolder: activeAccount.bankHolder || req.user.bankHolder || "",
      bankTargetAccountId: activeAccountDoc?.id || "",
      type: "deposit",
      amount,
      reference,
      status: "pending",
      adminNote: "",
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Цэнэглэлтийн хүсэлт амжилттай илгээгдлээ."
    });

  } catch (error) {
    console.error("DEPOSIT ERROR:", error);
    res.status(500).json({ message: "Хүсэлт илгээхэд алдаа гарлаа." });
  }
});

// ==========================================
// WITHDRAW REQUEST
// ==========================================

app.post("/api/cashier/withdraw", authUser, async (req, res) => {
  try {
    const amount = validAmount(req.body.amount);

    if (!amount) {
      return res.status(400).json({ message: "Дүн буруу байна." });
    }
    if (amount < MIN_WITHDRAW) {
      return res.status(400).json({ message: `Татан авах доод хэмжээ ${MIN_WITHDRAW.toLocaleString()} CHIP байна.` });
    }

    if (!req.user.bankName ||
        !req.user.bankAccount ||
        !req.user.bankHolder) {
      return res.status(400).json({
        message: "Эхлээд банкны мэдээллээ профайл хэсэгт бүртгүүлнэ үү."
      });
    }

    const userRef = req.userRef;
    const requestRef = db.collection("cashierRequests").doc();

    await db.runTransaction(async transaction => {
      const snap = await transaction.get(userRef);

      if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");

      const balance = Number(snap.data().chips || 0);

      if (balance < amount) {
        throw new Error("Таны CHIP хүрэлцэхгүй байна.");
      }

      transaction.update(userRef, {
        chips: balance - amount
      });

      transaction.set(requestRef, {
        uid: req.user.uid,
        username: req.user.username,
        displayName: req.user.displayName || req.user.username,
        bankName: req.user.bankName,
        bankAccount: req.user.bankAccount,
        bankHolder: req.user.bankHolder,
        type: "withdraw",
        amount,
        reference: "",
        status: "pending",
        adminNote: "",
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Татан авалтын хүсэлт илгээгдлээ."
    });

  } catch (error) {
    res.status(400).json({
      message: error.message || "Хүсэлт илгээхэд алдаа гарлаа."
    });
  }
});

// ==========================================
// CASHIER HISTORY
// ==========================================

app.get("/api/cashier/history", authUser, async (req, res) => {
  try {
    const snap = await db.collection("cashierRequests")
      .where("uid", "==", req.user.uid)
      .limit(100)
      .get();

    const requests = snap.docs
      .map(doc => publicRequest({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() || 0;
        const tb = b.createdAt?.toMillis?.() || 0;
        return tb - ta;
      });

    res.json({ requests });

  } catch (error) {
    res.status(500).json({ message: "Түүх ачааллахад алдаа гарлаа." });
  }
});

// ==========================================
// ADMIN: CASHIER REQUEST LIST
// ==========================================

app.get("/api/admin/cashier/list", authUser, authAdmin, async (req, res) => {
  try {
    const snap = await db.collection("cashierRequests")
      .where("status", "==", "pending")
      .limit(200)
      .get();

    const requests = snap.docs.map(doc =>
      publicRequest({ id: doc.id, ...doc.data() })
    );

    res.json({ requests });

  } catch (error) {
    res.status(500).json({ message: "Хүсэлтүүдийг ачааллахад алдаа гарлаа." });
  }
});

// ==========================================
// ADMIN: CASHIER DECISION
// ==========================================

app.post("/api/admin/cashier/decision", authUser, authAdmin, async (req, res) => {
  try {
    const requestId = String(req.body.requestId || "");
    const decision = String(req.body.decision || "").toLowerCase();
    const note = String(req.body.note || "").trim();

    if (!requestId || !["approve", "reject"].includes(decision)) {
      return res.status(400).json({ message: "Мэдээлэл буруу байна." });
    }

    const requestRef = db.collection("cashierRequests").doc(requestId);

    await db.runTransaction(async transaction => {
      const requestSnap = await transaction.get(requestRef);

      if (!requestSnap.exists) {
        throw new Error("Хүсэлт олдсонгүй.");
      }

      const request = requestSnap.data();

      if (request.status !== "pending") {
        throw new Error("Энэ хүсэлт өмнө нь шийдвэрлэгдсэн байна.");
      }

      const userRef = db.collection("users").doc(request.uid);
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) {
        throw new Error("Хэрэглэгч олдсонгүй.");
      }

      if (decision === "approve") {
        if (request.type === "deposit") {
          transaction.update(userRef, {
            chips: FieldValue.increment(Number(request.amount))
          });
        }
      } else if (request.type === "withdraw") {
        transaction.update(userRef, {
          chips: FieldValue.increment(Number(request.amount))
        });
      }

      transaction.update(requestRef, {
        status: decision === "approve" ? "approved" : "rejected",
        adminNote: note,
        decidedAt: FieldValue.serverTimestamp(),
        decidedBy: req.user.uid
      });
    });

    res.json({
      success: true,
      message: decision === "approve"
        ? "Хүсэлт баталгаажлаа."
        : "Хүсэлт буцаагдлаа."
    });

  } catch (error) {
    res.status(400).json({
      message: error.message || "Хүсэлт шийдвэрлэхэд алдаа гарлаа."
    });
  }
});

// ==========================================
// ADMIN: USERS
// ==========================================

app.get("/api/admin/users", authUser, authAdmin, async (req, res) => {
  try {
    const snap = await db.collection("users").limit(300).get();

    const users = snap.docs.map(doc => cleanUser(doc.data(), doc.id));

    res.json({ users });

  } catch (error) {
    res.status(500).json({ message: "Хэрэглэгчдийн мэдээлэл ачааллахад алдаа гарлаа." });
  }
});

// ROOT ADMIN: only the first ADMIN_UIDS entry may grant/revoke secondary admin role.
app.get("/api/admin/admins", authUser, authAdmin, async (req,res) => {
  try {
    const rootUid=ADMIN_UIDS[0]||"";
    if(!rootUid || req.user.uid!==rootUid) return res.status(403).json({message:"Зөвхөн үндсэн админ энэ хэсгийг удирдана."});
    const snap=await db.collection("users").where("role","==","admin").limit(100).get();
    const admins=snap.docs.map(d=>({uid:d.id,username:d.data().username||"",displayName:d.data().displayName||"",root:d.id===rootUid}));
    const root=await db.collection("users").doc(rootUid).get();
    if(root.exists&&!admins.some(a=>a.uid===rootUid)) admins.unshift({uid:rootUid,username:root.data().username||"",displayName:root.data().displayName||"",root:true});
    res.json({admins,rootUid});
  } catch(e) { res.status(500).json({message:"Админы жагсаалт ачаалж чадсангүй."}); }
});
app.post("/api/admin/admins/set", authUser, authAdmin, async (req,res) => {
  try {
    const rootUid=ADMIN_UIDS[0]||"";
    if(!rootUid || req.user.uid!==rootUid) return res.status(403).json({message:"Зөвхөн үндсэн админ дэд админ нэмэх эрхтэй."});
    const uid=String(req.body.uid||"").trim(), enabled=req.body.enabled===true;
    if(!uid) return res.status(400).json({message:"Хэрэглэгчийн UID оруулна уу."});
    if(uid===rootUid) return res.status(400).json({message:"Үндсэн админы эрхийг энэ хэсгээс өөрчлөхгүй."});
    const ref=db.collection("users").doc(uid), snap=await ref.get();
    if(!snap.exists) return res.status(404).json({message:"Хэрэглэгч олдсонгүй. Эхлээд тухайн хэрэглэгч бүртгүүлсэн байх ёстой."});
    await ref.set({role:enabled?"admin":"user",isAdmin:enabled,adminRoleUpdatedAt:FieldValue.serverTimestamp(),adminRoleUpdatedBy:req.user.uid},{merge:true});
    await db.collection("adminAudit").add({actorUid:req.user.uid,targetUid:uid,action:enabled?"grant_admin":"revoke_admin",createdAt:FieldValue.serverTimestamp()});
    res.json({success:true,message:enabled?"Дэд админ нэмэгдлээ.":"Дэд админы эрх цуцлагдлаа."});
  } catch(e) { res.status(500).json({message:"Админы эрх өөрчлөхөд алдаа гарлаа."}); }
});

// ==========================================
// ADMIN: READ-ONLY SYSTEM STATUS + RAKE REPORT
// ==========================================
app.get("/api/admin/system", authUser, authAdmin, async (req, res) => {
  try {
    const activeTables = [...tables.values()];
    const rakeSnap = await db.collection("rakeLedger").orderBy("createdAt", "desc").limit(50).get();
    res.json({
      connectedSessions: socketUsers.size,
      totalTables: activeTables.length,
      activeHands: activeTables.filter(t => t.handStarted).length,
      seatedPlayers: activeTables.reduce((n, t) => n + t.players.length, 0),
      rakeEntries: rakeSnap.docs.map(d => ({ id:d.id, ...d.data() }))
    });
  } catch (error) { res.status(500).json({ message:"Системийн тайлан ачаалж чадсангүй." }); }
});

// ==========================================
// ADMIN: COMPLETED HAND AUDIT (ADMIN ONLY)
// Private cards are returned only from immutable completed-hand records.
// ==========================================
app.get("/api/admin/hands", authUser, authAdmin, async (req, res) => {
  try {
    const snap = await db.collection("handHistory").orderBy("createdAt", "desc").limit(100).get();
    res.json({ hands: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (error) {
    res.status(500).json({ message: "Дууссан гарын аудит ачааллахад алдаа гарлаа." });
  }
});

// ==========================================
// ADMIN: BOT SETTINGS (CONFIG ONLY; BOT ENGINE NOT CONNECTED)
// ==========================================
app.get("/api/admin/bots/settings", authUser, authAdmin, async (req, res) => {
  try { const snap = await db.collection("adminSettings").doc("bots").get(); res.json({ settings: snap.exists ? (snap.data() || {}) : { enabled:false, count:2, style:"balanced", thinkSeconds:5 } }); }
  catch (error) { res.status(500).json({ message: "Ботын тохиргоо уншиж чадсангүй." }); }
});
app.post("/api/admin/bots/settings", authUser, authAdmin, async (req, res) => {
  try {
    const count = Number(req.body.count), thinkSeconds = Number(req.body.thinkSeconds), style = String(req.body.style || "balanced");
    const enabled = req.body.enabled === true;
    if (!Number.isInteger(count) || count < 0 || count > 8 || !Number.isInteger(thinkSeconds) || thinkSeconds < 2 || thinkSeconds > 30 || !["balanced","tight","loose"].includes(style)) return res.status(400).json({ message:"Ботын тохиргооны утга буруу байна." });
    await db.collection("adminSettings").doc("bots").set({ enabled, count, style, thinkSeconds, updatedAt:FieldValue.serverTimestamp(), updatedBy:req.user.uid }, { merge:true });
    res.json({ success:true, message:"Ботын тохиргоо хадгалагдлаа. Ботын тоглогчийн модуль холбогдоогүй тул ширээнд одоогоор автоматаар суухгүй." });
  } catch (error) { res.status(500).json({ message:"Ботын тохиргоо хадгалж чадсангүй." }); }
});

// ==========================================
// ADMIN: LIVE TABLE MONITOR (ADMIN ONLY)
// ==========================================
app.get("/api/admin/tables", authUser, authAdmin, async (req, res) => {
  try {
    const liveTables = [...tables.values()].map(table => ({
      id: table.id, name: table.name, type: table.type, street: table.street,
      handStarted: !!table.handStarted, handNumber: table.handNumber || 0,
      pot: table.pot || 0, currentBet: table.currentBet || 0,
      currentTurn: table.currentTurn || 0,
      players: table.players.map((p, index) => ({
        uid: p.uid, username: p.username, displayName: p.displayName,
        bet: p.bet || 0, folded: !!p.folded,
        online: p.online !== false, allIn: !!p.allIn, seat: index
      })),
      communityCards: table.communityCards || [], deckRemaining: Array.isArray(table.deck) ? table.deck.length : 0
    }));
    res.json({ tables: liveTables });
  } catch (error) {
    res.status(500).json({ message: "Ширээний мэдээлэл авахад алдаа гарлаа." });
  }
});

// ==========================================
// ADMIN: BLOCK / UNBLOCK ACCOUNT
// ==========================================
app.post("/api/admin/user/block", authUser, authAdmin, async (req, res) => {
  try {
    const uid = String(req.body.uid || "");
    const blocked = req.body.blocked === true;
    if (!uid) return res.status(400).json({ message: "Хэрэглэгчийн ID дутуу байна." });
    if (uid === req.user.uid) return res.status(400).json({ message: "Өөрийн админ бүртгэлийг хаах боломжгүй." });
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: "Хэрэглэгч олдсонгүй." });
    const target = snap.data() || {};
    if (target.role === "admin" || target.isAdmin === true || ADMIN_UIDS.includes(uid)) {
      return res.status(403).json({ message: "Админ бүртгэлийг энэ хэсгээс хаах боломжгүй." });
    }
    await ref.set({ blocked, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    try { await admin.auth().updateUser(uid, { disabled: blocked }); }
    catch (authError) {
      if (authError.code !== "auth/user-not-found") throw authError;
    }
    if (blocked) {
      for (const [socketId, session] of socketUsers.entries()) {
        if (session.uid === uid) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) targetSocket.disconnect(true);
        }
      }
    }
    res.json({ success: true, message: blocked ? "Бүртгэл хаагдлаа." : "Бүртгэлийн эрх сэргээгдлээ." });
  } catch (error) {
    res.status(400).json({ message: error.message || "Бүртгэлийн төлөв өөрчлөхөд алдаа гарлаа." });
  }
});

// ==========================================
// ADMIN: ADD / REMOVE CHIPS
// ==========================================

app.post("/api/admin/chips", authUser, authAdmin, async (req, res) => {
  try {
    const uid = String(req.body.uid || "");
    const amount = validAmount(req.body.amount);
    const action = String(req.body.action || "").toLowerCase();

    if (!uid || !amount || !["add", "remove"].includes(action)) {
      return res.status(400).json({ message: "Мэдээлэл буруу байна." });
    }

    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async transaction => {
      const snap = await transaction.get(userRef);

      if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");

      const current = Number(snap.data().chips || 0);
      const next = action === "add" ? current + amount : current - amount;

      if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error("CHIP үлдэгдэл хүрэлцэхгүй эсвэл дүн хэтэрсэн байна.");
      }

      transaction.update(userRef, { chips: next });
    });

    res.json({ success: true, message: "CHIP амжилттай шинэчлэгдлээ." });

  } catch (error) {
    res.status(400).json({
      message: error.message || "CHIP шинэчлэхэд алдаа гарлаа."
    });
  }
});

// ==========================================
// POKER TABLES
// ==========================================

// Blind түвшин бүрт Texas 3 ширээ, 9 суудалтай; Omaha 2 ширээ, 6 суудалтай.
// Omaha нь 6 хувийн хөзөртэй (6-card Omaha) бөгөөд яг 2 хувийн + 3 нийтийн хөзөр ашиглана.
const STAKES = [
  [100, 200], [250, 500], [500, 1000], [1000, 2000],
  [2500, 5000], [5000, 10000], [10000, 20000]
];
const MIN_BUY_IN_BY_BIG_BLIND = { 200: 5000, 500: 7500, 1000: 10000, 2000: 20000, 5000: 50000, 10000: 100000, 20000: 250000 };
const TABLE_CONFIG = [];
for (const [smallBlind, bigBlind] of STAKES) {
  for (const type of ["texas", "omaha"]) {
    const copies = type === "omaha" ? 2 : 3;
    for (let copy = 1; copy <= copies; copy++) {
      const typeName = type === "texas" ? "HOLD'EM" : "OMAHA 6-CARD";
      const id = `${type.toUpperCase()}_${smallBlind}_${bigBlind}_${copy}`;
      TABLE_CONFIG.push({
        id,
        name: `${typeName} ${smallBlind.toLocaleString("en-US")}/${bigBlind.toLocaleString("en-US")} · ${copy}`,
        type,
        smallBlind,
        bigBlind,
        minBuyIn: MIN_BUY_IN_BY_BIG_BLIND[bigBlind] || bigBlind * 25,
        maxBuyIn: bigBlind * 250,
        maxPlayers: type === "omaha" ? 6 : 9
      });
    }
  }
}

const tables = new Map();
const socketUsers = new Map();

for (const config of TABLE_CONFIG) {
  tables.set(config.id, {
    ...config,
    players: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    currentTurn: 0,
    dealerIndex: -1,
    handStarted: false,
    street: "waiting",
    deck: [],
    handNumber: 0,
    lastRaiseSize: config.bigBlind,
    lastResult: null
  });
}

function getTable(tableId) {
  return tables.get(String(tableId || "").toUpperCase());
}

function getPublicTable(table, viewerUid = null) {
  return {
    id: table.id,
    name: table.name,
    type: table.type,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    maxPlayers: table.maxPlayers,
    turnDeadline: table.turnDeadline || null,
    players: table.players.map((player, index) => ({
      id: player.uid,
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      chips: player.chips,
      bet: player.bet || 0,
      seat: Number.isInteger(player.seat) ? player.seat : index,
      online: player.online !== false,
      folded: !!player.folded,
      allIn: !!player.allIn,
      cards: (viewerUid && player.uid === viewerUid) || (table.street === "showdown" && !player.folded) ? (player.cards || []) : []
    })),
    communityCards: table.communityCards || [],
    pot: table.pot || 0,
    currentBet: table.currentBet || 0,
    currentTurn: table.currentTurn || 0,
    handStarted: !!table.handStarted,
    street: table.street,
    handNumber: table.handNumber,
    lastResult: table.lastResult || null
  };
}

function scheduleTurnTimeout(table) {
  const expectedUid = table.handStarted && table.currentTurn >= 0
    ? table.players[table.currentTurn]?.uid
    : null;
  if (!expectedUid) {
    if (table.turnTimer) clearTimeout(table.turnTimer);
    table.turnTimer = null;
    table.turnTimerUid = null;
    table.turnTimerHand = null;
    table.turnDeadline = null;
    return;
  }
  if (table.turnTimer && table.turnTimerUid === expectedUid && table.turnTimerHand === table.handNumber && table.turnDeadline) return;
  if (table.turnTimer) clearTimeout(table.turnTimer);
  table.turnTimerUid = expectedUid;
  table.turnTimerHand = table.handNumber;
  table.turnDeadline = Date.now() + 30 * 1000;
  const expectedHand = table.handNumber;
  table.turnTimer = setTimeout(() => {
    if (!table.handStarted || table.handNumber !== expectedHand) return;
    const current = table.players[table.currentTurn];
    if (!current || current.uid !== expectedUid || current.folded || current.allIn) return;
    current.folded = true;
    current.acted = true;
    current.lastAction = "timeout-fold";
    table.turnTimer = null;
    table.turnTimerUid = null;
    table.turnTimerHand = null;
    table.turnDeadline = null;
    advanceTurnOrStreet(table);
    io.to("table:" + table.id).emit("notice", { message: `${current.displayName || current.username} — 30 секундын хугацаа дууссан тул автоматаар FOLD боллоо. Та ширээндээ үлдлээ.` });
  }, 30 * 1000);
  if (typeof table.turnTimer.unref === "function") table.turnTimer.unref();
}

function sendTableUpdate(table) {
  scheduleTurnTimeout(table);
  // Хувийн хөзрийг зөвхөн тухайн тоглогчийн socket руу илгээнэ.
  for (const [socketId, session] of socketUsers.entries()) {
    if (session.tableId !== table.id) continue;
    const target = io.sockets.sockets.get(socketId);
    if (target) target.emit("table:update", getPublicTable(table, session.uid));
  }
  // Socket-ийн session бүртгэгдээгүй observer-д хувийн хөзөргүй төлөв.
  io.to("table:" + table.id).except([...socketUsers.keys()]).emit("table:update", getPublicTable(table));
}

function sendLobby() {
  const onlineUsers = new Set();

  for (const entry of socketUsers.values()) {
    if (entry.uid) onlineUsers.add(entry.uid);
  }

  const publicTables = [...tables.values()].map(table => ({
    id: table.id,
    name: table.name,
    type: table.type,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    maxPlayers: table.maxPlayers,
    players: table.players.map(player => ({
      uid: player.uid,
      username: player.username,
      chips: player.chips,
      online: player.online !== false
    }))
  }));

  io.emit("lobby:update", {
    tables: publicTables,
    onlineCount: onlineUsers.size
  });
}

function makeDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = [
    "2", "3", "4", "5", "6", "7", "8",
    "9", "10", "J", "Q", "K", "A"
  ];

  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function getActivePlayers(table) {
  return table.players.filter(player => !player.folded);
}

function nextPlayerIndex(table, fromIndex, predicate = p => !p.folded && p.chips > 0) {
  if (!table.players.length) return 0;
  for (let step = 1; step <= table.players.length; step++) {
    const index = (fromIndex + step + table.players.length) % table.players.length;
    if (table.players[index] && predicate(table.players[index])) return index;
  }
  return -1;
}

const RANK_VALUE = {"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,J:11,Q:12,K:13,A:14};
function combinations(items, size) {
  const out = [];
  function walk(start, picked) {
    if (picked.length === size) { out.push(picked); return; }
    for (let i = start; i <= items.length - (size - picked.length); i++) walk(i + 1, [...picked, items[i]]);
  }
  walk(0, []);
  return out;
}
function scoreFive(cards) {
  const values = cards.map(c => RANK_VALUE[c.rank]).sort((a,b) => b-a);
  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts).map(([v,n]) => [Number(v),n]).sort((a,b) => b[1]-a[1] || b[0]-a[0]);
  const flush = cards.every(c => c.suit === cards[0].suit);
  const unique = [...new Set(values)].sort((a,b) => b-a);
  let straightHigh = 0;
  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0];
  if (unique.join(",") === "14,5,4,3,2") straightHigh = 5;
  if (flush && straightHigh) return [8,straightHigh];
  if (groups[0][1] === 4) return [7,groups[0][0],groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6,groups[0][0],groups[1][0]];
  if (flush) return [5,...values];
  if (straightHigh) return [4,straightHigh];
  if (groups[0][1] === 3) return [3,groups[0][0],...groups.slice(1).map(x=>x[0]).sort((a,b)=>b-a)];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2,Math.max(groups[0][0],groups[1][0]),Math.min(groups[0][0],groups[1][0]),groups[2][0]];
  if (groups[0][1] === 2) return [1,groups[0][0],...groups.slice(1).map(x=>x[0]).sort((a,b)=>b-a)];
  return [0,...values];
}
function compareScores(a,b) {
  for (let i=0;i<Math.max(a.length,b.length);i++) {
    const d=(a[i]||0)-(b[i]||0); if(d) return d;
  }
  return 0;
}
function evaluatePlayer(table, player) {
  const board = table.communityCards;
  if (board.length !== 5) return [0];
  let pool;
  if (table.type === "omaha") {
    if (player.cards.length !== 6) return [0];
    const scores=[];
    for (const hole of combinations(player.cards,2)) for (const community of combinations(board,3)) scores.push(scoreFive([...hole,...community]));
    return scores.sort((a,b)=>compareScores(b,a))[0] || [0];
  }
  pool = [...player.cards,...board];
  return combinations(pool,5).map(scoreFive).sort((a,b)=>compareScores(b,a))[0] || [0];
}
function handName(score) {
  return ["Өндөр карт","Хос","Хоёр хос","Гурвал","Дараалал","Өнгө","Фулл хаус","Дөрөв","Стрэйт флэш"][score[0]] || "";
}
function persistStacks(table) {
  const batch = db.batch();
  for (const player of table.players) {
    batch.set(db.collection("users").doc(player.uid), { activeTable: table.id, tableStack: player.chips, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return batch.commit();
}
function finishHand(table, forcedWinner = null) {
  if (!table.handStarted) return; // Давхар settle хийхээс хамгаална.
  if (table.turnTimer) clearTimeout(table.turnTimer);
  table.turnTimer = null;
  const active = getActivePlayers(table);
  if (!active.length) return;
  const grossPot = Math.max(0, Number(table.pot || 0));
  const rakeEligible = (table.communityCards || []).length >= 3;
  const rake = rakeEligible ? Math.min(grossPot, Math.floor(grossPot * casinoSettings.rakePercent / 100), Math.floor(Number(table.bigBlind || 0) * casinoSettings.rakeCapBB)) : 0;
  const jackpotContribution = Math.floor(rake * casinoSettings.jackpotRakePercent / 100);
  let winners = forcedWinner ? [forcedWinner] : [];
  let winningScore = null;
  let rakeRemaining = rake;
  if (forcedWinner) {
    forcedWinner.chips += grossPot - rake;
  } else {
    const levels = [...new Set(table.players.map(p => Number(p.totalBet || 0)).filter(n => n > 0))].sort((a,b)=>a-b);
    let previous = 0;
    for (const level of levels) {
      const contributors = table.players.filter(p => Number(p.totalBet || 0) >= level);
      const layer = (level - previous) * contributors.length;
      previous = level;
      if (!layer) continue;
      const eligible = contributors.filter(p => !p.folded);
      if (!eligible.length) continue;
      // Rake is allocated proportionally across side-pot layers.
      const layerRake = grossPot > 0 ? Math.min(rakeRemaining, Math.floor(rake * layer / grossPot)) : 0;
      rakeRemaining -= layerRake;
      let best = null, layerWinners = [];
      for (const player of eligible) {
        const score = evaluatePlayer(table, player);
        if (!best || compareScores(score,best)>0) { best=score; layerWinners=[player]; }
        else if (compareScores(score,best)===0) layerWinners.push(player);
      }
      const netLayer = Math.max(0, layer - layerRake);
      const share=Math.floor(netLayer/layerWinners.length); let rem=netLayer-share*layerWinners.length;
      layerWinners.forEach(p=>{p.chips+=share+(rem-->0?1:0);});
      winners=[...new Set([...winners,...layerWinners])];
      if (!winningScore || (best && compareScores(best,winningScore)>0)) winningScore=best;
    }
    // Any rounding remainder is deducted from total awards, not minted back.
    if (rakeRemaining > 0 && winners.length) {
      const take = Math.min(rakeRemaining, ...winners.map(p => p.chips));
      winners[0].chips = Math.max(0, winners[0].chips - take);
    }
  }
  const handRecord = { tableId: table.id, tableName: table.name || table.id, handNumber: table.handNumber || 0, gameType: table.type || "texas", street: table.street, communityCards: (table.communityCards || []).map(c=>({...c})), players: table.players.map(p=>({ uid:p.uid, username:p.username, cards:(p.cards||[]).map(c=>({...c})), totalBet:Number(p.totalBet||0), folded:!!p.folded })), winners: winners.map(p=>({ uid:p.uid, username:p.username })), hand: winningScore ? handName(winningScore) : "Бусад нь бууж өгсөн", grossPot, rake, jackpotContribution, netPot:grossPot-rake, createdAt: FieldValue.serverTimestamp() };
  table.lastResult = { winners: winners.map(p=>p.username), hand: handRecord.hand, pot: grossPot-rake, rake };
  table.pot = 0; table.currentBet = 0; table.handStarted = false; table.street = "showdown"; table.currentTurn = -1;
  for (const player of table.players) { player.bet=0; player.acted=false; player.allIn=false; player.cards=player.cards||[]; }
  // Persist stack, immutable hand history and rake ledger. Rake is recorded once per settled hand.
  const batch = db.batch();
  batch.set(db.collection("handHistory").doc(`${table.id}_${table.handNumber || Date.now()}`), handRecord);
  if (rake > 0) batch.set(db.collection("rakeLedger").doc(`${table.id}_${table.handNumber || Date.now()}`), { tableId:table.id, handNumber:table.handNumber||0, grossPot, rake, jackpotContribution, rakePercent:casinoSettings.rakePercent, createdAt:FieldValue.serverTimestamp() });
  for (const player of table.players) batch.set(db.collection("users").doc(player.uid), { activeTable: table.id, tableStack: player.chips, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.commit().then(async()=>{
    if (jackpotContribution > 0) await db.collection("casinoStats").doc("global").set({ jackpotPool:FieldValue.increment(jackpotContribution), totalRake:FieldValue.increment(rake), updatedAt:FieldValue.serverTimestamp() },{merge:true});
    else if (rake > 0) await db.collection("casinoStats").doc("global").set({ totalRake:FieldValue.increment(rake), updatedAt:FieldValue.serverTimestamp() },{merge:true});
  }).catch(err=>console.error("Hand/rake persistence:",err));
  sendTableUpdate(table); sendLobby();
}

function bettingRoundComplete(table) {
  const eligible = table.players.filter(p => !p.folded && !p.allIn && p.chips > 0);
  if (!eligible.length) return true;
  return eligible.every(p => p.acted && p.bet === table.currentBet);
}
function advanceTurnOrStreet(table) {
  const active = getActivePlayers(table);
  if (active.length === 1) { finishHand(table, active[0]); return; }
  if (bettingRoundComplete(table)) {
    const canBet = active.filter(p=>!p.allIn && p.chips>0);
    if (canBet.length <= 1) { runOutBoard(table); return; }
    advanceStreet(table); return;
  }
  const next = nextPlayerIndex(table, table.currentTurn, p => !p.folded && !p.allIn && p.chips > 0 && (!p.acted || p.bet < table.currentBet));
  if (next >= 0) table.currentTurn = next;
  sendTableUpdate(table); sendLobby();
}
function runOutBoard(table) {
  while (table.communityCards.length < 5) {
    if (table.communityCards.length === 0) { table.deck.pop(); table.communityCards.push(table.deck.pop(),table.deck.pop(),table.deck.pop()); }
    else { table.deck.pop(); table.communityCards.push(table.deck.pop()); }
  }
  finishHand(table);
}
function advanceStreet(table) {
  if (table.street === "preflop") { table.deck.pop(); table.communityCards.push(table.deck.pop(),table.deck.pop(),table.deck.pop()); table.street="flop"; }
  else if (table.street === "flop") { table.deck.pop(); table.communityCards.push(table.deck.pop()); table.street="turn"; }
  else if (table.street === "turn") { table.deck.pop(); table.communityCards.push(table.deck.pop()); table.street="river"; }
  else if (table.street === "river") { finishHand(table); return; }
  for (const player of table.players) { player.bet=0; player.acted=false; }
  table.currentBet=0;
  const next=nextPlayerIndex(table,table.dealerIndex,p=>!p.folded&&!p.allIn&&p.chips>0);
  if (next < 0) { runOutBoard(table); return; }
  table.currentTurn=next;
  sendTableUpdate(table);
}
function startHand(table) {
  const eligible=table.players.filter(p=>p.online!==false&&p.chips>0);
  if (eligible.length<2 || table.handStarted) return false;
  table.deck=makeDeck(); table.communityCards=[]; table.pot=0; table.currentBet=0;
  table.handStarted=true; table.street="preflop"; table.handNumber+=1; table.lastResult=null; table.lastRaiseSize=table.bigBlind;
  table.dealerIndex=(table.dealerIndex+1)%table.players.length;
  for (const p of table.players) { p.folded=p.online===false||p.chips<=0; p.bet=0; p.totalBet=0; p.acted=false; p.allIn=false; p.cards=[]; }
  const active=table.players.filter(p=>!p.folded);
  const holeCount=table.type==="omaha"?6:2;
  for(let n=0;n<holeCount;n++) for(const p of active) p.cards.push(table.deck.pop());
  const dealer=table.dealerIndex;
  let sbIndex,bbIndex;
  if(active.length===2){ sbIndex=dealer; if(table.players[sbIndex].folded) sbIndex=nextPlayerIndex(table,sbIndex); bbIndex=nextPlayerIndex(table,sbIndex); }
  else { sbIndex=nextPlayerIndex(table,dealer); bbIndex=nextPlayerIndex(table,sbIndex); }
  const sb=table.players[sbIndex], bb=table.players[bbIndex];
  const postBlind=(p,amount)=>{const paid=Math.min(p.chips,amount);p.chips-=paid;p.bet+=paid;p.totalBet=(p.totalBet||0)+paid;table.pot+=paid;p.allIn=p.chips===0;};
  postBlind(sb,table.smallBlind); postBlind(bb,table.bigBlind);
  table.currentBet=Math.max(sb.bet,bb.bet);
  const first=nextPlayerIndex(table,bbIndex,p=>!p.folded&&!p.allIn&&p.chips>0);
  table.currentTurn=first<0?-1:first;
  // Blind-уудын дараах үлдэгдлийг шууд хадгална.
  persistStacks(table).catch(err=>console.error("Blind stack save error:",err));
  if(first<0) runOutBoard(table); else sendTableUpdate(table);
  sendLobby(); return true;
}

async function getSocketUser(socket) {
  const token = socket.handshake.auth?.token;

  if (!token) throw new Error("Нэвтрэх шаардлагатай.");

  const decoded = await admin.auth().verifyIdToken(token);
  const snap = await db.collection("users").doc(decoded.uid).get();

  if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");
  if (snap.data().blocked === true) throw new Error("Энэ бүртгэлийг админ түр хаасан байна.");

  return {
    ...snap.data(),
    uid: decoded.uid
  };
}

async function refundPlayerChips(uid, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) return;

  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(userRef);
    if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");
    const data = snap.data() || {};
    // Server memory дахь тухайн тоглогчийн stack нь энэ session-ийн эцсийн үнэн дүн.
    // tableStack талбарын асинхрон хадгалалт хоцорсон байсан ч CHIP алдагдуулахгүй.
    const stack = amount;
    const wallet = Number(data.chips || 0);
    transaction.update(userRef, {
      chips: wallet + stack,
      activeTable: FieldValue.delete(),
      tableStack: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

function removePlayerFromTable(table, uid) {
  const index = table.players.findIndex(player => player.uid === uid);

  if (index < 0) return false;

  table.players.splice(index, 1);

  if (table.currentTurn > index) table.currentTurn--;
  if (table.currentTurn >= table.players.length) table.currentTurn = table.players.length ? 0 : -1;
  if (table.dealerIndex > index) table.dealerIndex--;
  if (table.dealerIndex >= table.players.length) table.dealerIndex = table.players.length ? 0 : -1;

  return true;
}

// ==========================================
// SOCKET CONNECTIONS
// ==========================================

io.on("connection", socket => {
  socket.on("chat:history", async (data={}) => {
    try {
      const user=await getSocketUser(socket); const mode=["table","global","support"].includes(data.mode)?data.mode:"table";
      const snap=await db.collection("chatMessages").where("mode","==",mode).limit(100).get();
      let rows=snap.docs.map(d=>({id:d.id,...d.data()}));
      const isAdmin=ADMIN_UIDS.includes(user.uid)||user.role==="admin"||user.isAdmin===true;
      if(mode==="support"&&!isAdmin) rows=rows.filter(m=>m.uid===user.uid);
      if(mode==="table") { const tid=String(data.tableId||""); rows=rows.filter(m=>m.tableId===tid); }
      socket.emit("chat:history",rows.slice(-80).reverse());
    } catch(e){ socket.emit("notice",{message:e.message||"Чат ачаалж чадсангүй."}); }
  });
  socket.on("chat:clear", async (_data={}, callback) => {
    const reply=v=>{if(typeof callback==="function")callback(v);};
    try {
      const user=await getSocketUser(socket);
      const isAdmin=ADMIN_UIDS.includes(user.uid)||user.role==="admin"||user.isAdmin===true;
      if(!isAdmin) return reply({ok:false,message:"Зөвхөн админ чат устгах эрхтэй."});
      const collection=db.collection("chatMessages");
      let deleted=0;
      while(true){
        const snap=await collection.limit(450).get();
        if(snap.empty) break;
        const batch=db.batch();
        snap.docs.forEach(doc=>batch.delete(doc.ref));
        await batch.commit();
        deleted+=snap.size;
        if(snap.size<450) break;
      }
      io.emit("chat:cleared");
      reply({ok:true,deleted});
    } catch(e){reply({ok:false,message:e.message||"Чат устгаж чадсангүй."});}
  });

  socket.on("chat:send", async (data={}, callback) => {
    const reply=v=>{if(typeof callback==="function")callback(v);};
    try {
      const user=await getSocketUser(socket); const uref=db.collection("users").doc(user.uid); const usnap=await uref.get();
      if(!chatSettings.enabled && user.role!=="admin" && !user.isAdmin && !ADMIN_UIDS.includes(user.uid)) return reply({ok:false,message:"Админ чатыг түр хаасан байна."});
      if(usnap.data()?.chatMuted===true) return reply({ok:false,message:"Таны чат бичих эрхийг админ түр хаасан байна."});
      const now=Date.now(), prev=chatRate.get(user.uid)||[]; const recent=prev.filter(t=>now-t<10000);
      if(recent.length>=5 || (recent.length && now-recent[recent.length-1]<1200)) return reply({ok:false,message:"Хэт олон мессеж илгээлээ. Түр хүлээнэ үү."});
      const text=String(data.text||"").trim().slice(0,300); if(!text) return reply({ok:false,message:"Мессеж хоосон байна."});
      const mode=["table","global","support"].includes(data.mode)?data.mode:"table";
      const tableId=mode==="table"?String(data.tableId||""):"";
      if(mode==="table" && (!tableId || !socketUsers.get(socket.id)?.tableId || socketUsers.get(socket.id).tableId!==tableId)) return reply({ok:false,message:"Энэ ширээний чатад холбогдоогүй байна."});
      recent.push(now); chatRate.set(user.uid,recent);
      const msg={uid:user.uid,username:String(user.displayName||user.username||"Тоглогч").slice(0,24),text,mode,tableId,createdAt:FieldValue.serverTimestamp()};
      const ref=await db.collection("chatMessages").add(msg); const out={id:ref.id,...msg,createdAt:Date.now()};
      if(mode==="table") io.to("table:"+tableId).emit("chat:message",out); else if(mode==="global") io.emit("chat:message",out); else io.to("admins").emit("chat:message",out);
      reply({ok:true});
    } catch(e){reply({ok:false,message:e.message||"Мессеж илгээж чадсангүй."});}
  });

  socket.on("lobby:get", async () => {
    try {
      const user = await getSocketUser(socket);

      socketUsers.set(socket.id, {
        uid: user.uid,
        tableId: null
      });
      if (user.role === "admin" || user.isAdmin === true || ADMIN_UIDS.includes(user.uid)) socket.join("admins");

      for (const table of tables.values()) {
        const player = table.players.find(p => p.uid === user.uid);

        if (player) {
          player.online = true;

          socketUsers.set(socket.id, {
            uid: user.uid,
            tableId: table.id
          });

          socket.join("table:" + table.id);
          sendTableUpdate(table);
          break;
        }
      }

      sendLobby();

    } catch (error) {
      socket.emit("notice", {
        message: error.message || "Нэвтрэх эрх шалгахад алдаа гарлаа."
      });
    }
  });

  socket.on("table:join", async (data, callback) => {
    const reply = result => { if (typeof callback === "function") callback(result); };
    try {
      const user = await getSocketUser(socket);
      const table = getTable(data?.tableId);
      if (!table) return reply({ success: false, message: "Ширээ олдсонгүй." });

      const existing = table.players.find(p => p.uid === user.uid);
      if (!existing) {
        for (const otherTable of tables.values()) {
          if (otherTable.players.some(p => p.uid === user.uid)) {
            return reply({ success: false, message: "Та өөр ширээнд суусан байна." });
          }
        }
      } else {
        existing.online = true;
      }

      socketUsers.set(socket.id, { uid: user.uid, tableId: table.id });
      socket.join("table:" + table.id);
      sendTableUpdate(table);
      sendLobby();
      reply({
        success: true,
        seated: !!existing,
        table: getPublicTable(table, user.uid),
        walletChips: Number(user.chips || 0),
        minBuyIn: table.minBuyIn,
        maxBuyIn: table.maxBuyIn
      });
    } catch (error) {
      reply({ success: false, message: error.message || "Ширээ нээхэд алдаа гарлаа." });
    }
  });

  socket.on("table:sit", async (data, callback) => {
    const reply = result => { if (typeof callback === "function") callback(result); };
    try {
      const session = socketUsers.get(socket.id);
      if (!session?.tableId) return reply({ success: false, message: "Эхлээд ширээнд орно уу." });
      const user = await getSocketUser(socket);
      const table = getTable(session.tableId);
      if (!table) return reply({ success: false, message: "Ширээ олдсонгүй." });
      const existing = table.players.find(p => p.uid === user.uid);
      if (existing) return reply({ success: true, table: getPublicTable(table, user.uid), walletChips: Number(user.chips || 0) });
      if (table.handStarted) return reply({ success: false, message: "Одоогийн гар дууссаны дараа суудлаа сонгоно уу." });

      const seat = Number(data?.seat);
      if (!Number.isInteger(seat) || seat < 0 || seat >= table.maxPlayers) return reply({ success: false, message: "Суудлын дугаар буруу байна." });
      if (table.players.some(p => (Number.isInteger(p.seat) ? p.seat : -1) === seat)) return reply({ success: false, message: "Энэ суудлыг өөр тоглогч эзэлсэн байна." });
      if (table.players.length >= table.maxPlayers) return reply({ success: false, message: "Ширээ дүүрсэн байна." });

      const requestedBuyIn = Number(data?.buyIn);
      const buyIn = Number.isSafeInteger(requestedBuyIn) ? requestedBuyIn : table.minBuyIn;
      if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
        return reply({ success: false, message: `Энэ ширээний суух хэмжээ ${table.minBuyIn.toLocaleString()}–${table.maxBuyIn.toLocaleString()} CHIP байна.` });
      }
      const userRef = db.collection("users").doc(user.uid);
      let walletAfter = 0;
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(userRef);
        if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");
        const balance = Number(snap.data().chips || 0);
        if (!Number.isSafeInteger(balance) || balance < buyIn) { const short=Math.max(0,buyIn-balance); throw new Error(`CHIP хүрэлцэхгүй байна. Шаардлагатай: ${buyIn.toLocaleString()} CHIP · Үлдэгдэл: ${balance.toLocaleString()} CHIP · Дутуу: ${short.toLocaleString()} CHIP.`); }
        walletAfter = balance - buyIn;
        transaction.update(userRef, { chips: walletAfter, activeTable: table.id, tableStack: buyIn });
      });

      table.players.push({
        uid: user.uid,
        username: user.username || "Player",
        displayName: user.displayName || user.username || "Player",
        chips: buyIn,
        seat,
        bet: 0,
        folded: false,
        online: true,
        cards: [],
        acted: false,
        allIn: false,
        totalBet: 0
      });
      table.players.sort((a, b) => (Number.isInteger(a.seat) ? a.seat : 99) - (Number.isInteger(b.seat) ? b.seat : 99));
      if (!table.handStarted && table.players.filter(p => p.online !== false && p.chips > 0).length >= 2) startHand(table);
      else sendTableUpdate(table);
      sendLobby();
      reply({ success: true, table: getPublicTable(table, user.uid), buyIn, walletChips: walletAfter });
    } catch (error) {
      reply({ success: false, message: error.message || "Суудал сонгоход алдаа гарлаа." });
    }
  });

  socket.on("table:leave", async callback => {
    const reply = result => { if (typeof callback === "function") callback(result); };
    try {
      const session = socketUsers.get(socket.id);
      if (!session?.tableId) return reply({ success: true });
      const table = getTable(session.tableId);
      if (!table) return reply({ success: false, message: "Ширээ олдсонгүй." });
      const player = table.players.find(p => p.uid === session.uid);
      if (player && table.handStarted) {
        return reply({ success: false, message: "Тоглолт дууссаны дараа ширээнээс гараарай." });
      }
      if (player) {
        await refundPlayerChips(session.uid, player.chips);
        removePlayerFromTable(table, session.uid);
      }
      socket.leave("table:" + table.id);
      socketUsers.delete(socket.id);
      sendTableUpdate(table);
      sendLobby();
      reply({ success: true });
    } catch (error) {
      reply({ success: false, message: error.message || "Ширээнээс гарахад алдаа гарлаа." });
    }
  });

  // ----------------------------------------
  // PLAYER ACTION
  // ----------------------------------------

  socket.on("game:action", async data => {
    try {
      const session=socketUsers.get(socket.id); if(!session?.tableId) return;
      const table=getTable(session.tableId); if(!table||!table.handStarted) return;
      const player=table.players.find(p=>p.uid===session.uid);
      if(!player||player.folded||player.allIn) return;
      if(table.players[table.currentTurn]?.uid!==session.uid){socket.emit("notice",{message:"Одоо таны ээлж биш байна."});return;}
      const action=String(data?.action||"").toLowerCase();
      const raw=Number(data?.amount||0);
      const toCall=Math.max(0,table.currentBet-player.bet);
      if(action==="fold") { player.folded=true; player.acted=true; }
      else if(action==="check") { if(toCall>0){socket.emit("notice",{message:"Check хийх боломжгүй. Call эсвэл Fold сонгоно уу."});return;} player.acted=true; }
      else if(action==="call") {
        const paid=Math.min(toCall,player.chips); player.chips-=paid; player.bet+=paid; player.totalBet=(player.totalBet||0)+paid; table.pot+=paid; player.acted=true; player.allIn=player.chips===0;
      }
      else if(action==="raise") {
        const target=Math.floor(raw);
        if(!Number.isSafeInteger(target)||target<=table.currentBet||target<=player.bet){socket.emit("notice",{message:"Raise дүн буруу байна."});return;}
        const need=target-player.bet; if(need>player.chips){socket.emit("notice",{message:"CHIP хүрэлцэхгүй байна."});return;}
        const minRaise=table.currentBet===0?table.bigBlind:table.currentBet+table.lastRaiseSize;
        if(target<minRaise && need<player.chips){socket.emit("notice",{message:`Хамгийн бага raise ${minRaise.toLocaleString()} CHIP байна.`});return;}
        const previous=table.currentBet; player.chips-=need; player.bet+=need; player.totalBet=(player.totalBet||0)+need; table.pot+=need; table.currentBet=player.bet; player.acted=true; player.allIn=player.chips===0;
        if(table.currentBet>previous){
          const raiseSize=table.currentBet-previous;
          const reopens = raiseSize>=table.lastRaiseSize;
          if(reopens) table.lastRaiseSize=raiseSize;
          if(reopens){for(const other of table.players) if(other!==player&&!other.folded&&!other.allIn) other.acted=false;}
        }
      }
      else {socket.emit("notice",{message:"Үйлдэл буруу байна."});return;}
      persistStacks(table).catch(err=>console.error("Stack save error:",err));
      advanceTurnOrStreet(table);
    } catch(error) { socket.emit("notice",{message:error.message||"Үйлдэл хийхэд алдаа гарлаа."}); }
  });

  // ----------------------------------------
  // NEXT HAND / NEXT STREET
  // ----------------------------------------

  socket.on("game:next", () => {
    const session=socketUsers.get(socket.id); if(!session?.tableId) return;
    const table=getTable(session.tableId); if(!table) return;
    const player = table.players.find(p => p.uid === session.uid);
    if (!player) { socket.emit("notice", { message: "Дараагийн гар эхлүүлэхийн тулд эхлээд суудлаа сонгоно уу." }); return; }
    if(table.handStarted){return;}
    startHand(table);
  });

  socket.on("disconnect", () => {
    const session = socketUsers.get(socket.id);

    if (session?.tableId) {
      const table = getTable(session.tableId);

      if (table) {
        const player = table.players.find(p => p.uid === session.uid);

        if (player) {
          player.online = false;
          if (table.handStarted && !player.folded) {
            player.folded = true;
            player.acted = true;
            if (table.players[table.currentTurn]?.uid === session.uid) advanceTurnOrStreet(table);
          }
          sendTableUpdate(table);
        }
      }
    }

    socketUsers.delete(socket.id);
    sendLobby();
  });

});

// ==========================================
// ROOT + HEALTH
// ==========================================

app.get("/", (req, res) => {
  res.send("BLACKCLUB Poker Server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "BLACKCLUB Poker",
    time: new Date().toISOString()
  });
});

// ==========================================
// SERVER START
// ==========================================

server.listen(PORT, () => {
  console.log(`BLACKCLUB Poker server running on port ${PORT}`);
});
