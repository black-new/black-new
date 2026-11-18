
const express = require("express");
const http = require("http");
const cors = require("cors");
const admin = require("firebase-admin");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
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
    isAdmin: data.role === "admin" || !!data.isAdmin,
    bankName: data.bankName || "",
    bankAccount: data.bankAccount || "",
    bankHolder: data.bankHolder || ""
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

    req.userRef = userRef;
    next();
  } catch (error) {
    return res.status(401).json({
      message: "Нэвтрэх эрх хүчингүй эсвэл хугацаа дууссан байна."
    });
  }
}

function authAdmin(req, res, next) {
  if (!ADMIN_UIDS.includes(req.user.uid) &&
      req.user.role !== "admin" &&
      req.user.isAdmin !== true) {
    return res.status(403).json({ message: "Админ эрх шаардлагатай." });
  }

  next();
}

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
// ==========================================

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const displayName = String(
      req.body.displayName || username
    ).trim();
    const password = String(req.body.password || "");
    const confirmPassword = req.body.confirmPassword;

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

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        message: "Нууц үг таарахгүй байна."
      });
    }

    const normalized = normalizeUsername(username);
    const usernameRef = db.collection("usernames").doc(normalized);
    const existingUsername = await usernameRef.get();

    if (existingUsername.exists) {
      return res.status(409).json({
        message: "Энэ хэрэглэгчийн нэр бүртгэлтэй байна."
      });
    }

    const email = makeEmail(normalized);

    const account = await firebaseRequest("accounts:signUp", {
      email,
      password,
      returnSecureToken: true
    });

    const uid = account.localId;

    const userData = {
      username: normalized,
      displayName: displayName || normalized,
      chips: 0,
      role: "user",
      isAdmin: false,
      bankName: "",
      bankAccount: "",
      bankHolder: "",
      createdAt: FieldValue.serverTimestamp()
    };

    const batch = db.batch();

    batch.set(usernameRef, { uid });
    batch.set(db.collection("users").doc(uid), userData);

    await batch.commit();

    return res.json({
      success: true,
      token: account.idToken,
      refreshToken: account.refreshToken,
      user: cleanUser(userData, uid)
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    return res.status(400).json({
      message: error.message || "Бүртгэл үүсгэхэд алдаа гарлаа."
    });
  }
});

// ==========================================
// LOGIN
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

    const email = makeEmail(username);

    const account = await firebaseRequest(
      "accounts:signInWithPassword",
      {
        email,
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
// CASHIER INFO
// ==========================================

app.get("/api/cashier/info", authUser, async (req, res) => {
  res.json({
    bank: BANK_INFO,
    chips: Number(req.user.chips || 0)
  });
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

    if (amount > 100000000) {
      return res.status(400).json({ message: "Дүн хэт их байна." });
    }

    const requestRef = db.collection("cashierRequests").doc();

    await requestRef.set({
      uid: req.user.uid,
      username: req.user.username,
      displayName: req.user.displayName || req.user.username,
      bankName: req.user.bankName || "",
      bankAccount: req.user.bankAccount || "",
      bankHolder: req.user.bankHolder || "",
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
      } else {
        if (request.type === "withdraw") {
          transaction.update(userRef, {
            chips: FieldValue.increment(Number(request.amount))
          });
        }
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

    const users = snap.docs.map(doc => {
      const user = cleanUser(doc.data(), doc.id);
      return user;
    });

    res.json({ users });

  } catch (error) {
    res.status(500).json({ message: "Хэрэглэгчдийн мэдээлэл ачааллахад алдаа гарлаа." });
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

const TABLE_CONFIG = [
  {
    id: "BEGINNER",
    name: "BEGINNER",
    type: "texas",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 5000,
    maxBuyIn: 50000,
    maxPlayers: 6
  },
  {
    id: "SILVER",
    name: "SILVER",
    type: "texas",
    smallBlind: 500,
    bigBlind: 1000,
    minBuyIn: 25000,
    maxBuyIn: 250000,
    maxPlayers: 6
  },
  {
    id: "GOLD",
    name: "GOLD",
    type: "texas",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: 50000,
    maxBuyIn: 500000,
    maxPlayers: 6
  },
  {
    id: "BLACK",
    name: "BLACK",
    type: "omaha",
    smallBlind: 5000,
    bigBlind: 10000,
    minBuyIn: 250000,
    maxBuyIn: 2500000,
    maxPlayers: 6
  }
];

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
    handNumber: 0
  });
}

function getTable(tableId) {
  return tables.get(String(tableId || "").toUpperCase());
}

function getPublicTable(table) {
  return {
    id: table.id,
    name: table.name,
    type: table.type,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    maxPlayers: table.maxPlayers,
    players: table.players.map((player, index) => ({
      id: player.uid,
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      chips: player.chips,
      bet: player.bet || 0,
      seat: index,
      online: player.online !== false,
      folded: !!player.folded,
      cards: player.uid === table.players[table.currentTurn]?.uid
        ? player.cards || []
        : []
    })),
    communityCards: table.communityCards || [],
    pot: table.pot || 0,
    currentBet: table.currentBet || 0,
    currentTurn: table.currentTurn || 0,
    handStarted: !!table.handStarted,
    street: table.street,
    handNumber: table.handNumber
  };
}

function sendTableUpdate(table) {
  io.to("table:" + table.id).emit("table:update", getPublicTable(table));
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
  return table.players.filter(player =>
    !player.folded && player.chips >= 0
  );
}

function nextPlayerIndex(table, fromIndex) {
  if (!table.players.length) return 0;

  for (let step = 1; step <= table.players.length; step++) {
    const index = (fromIndex + step) % table.players.length;
    const player = table.players[index];

    if (player && !player.folded && player.chips > 0) {
      return index;
    }
  }

  return fromIndex;
}

function finishHand(table, winner) {
  if (winner) {
    winner.chips += table.pot;
  }

  table.pot = 0;
  table.currentBet = 0;
  table.handStarted = false;
  table.street = "waiting";
  table.communityCards = [];

  for (const player of table.players) {
    player.bet = 0;
    player.folded = false;
    player.cards = [];
  }

  sendTableUpdate(table);
  sendLobby();
}

function startHand(table) {
  const players = table.players.filter(player =>
    player.online !== false && player.chips > 0
  );

  if (players.length < 2) {
    return false;
  }

  table.deck = makeDeck();
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = table.bigBlind;
  table.handStarted = true;
  table.street = "preflop";
  table.handNumber += 1;

  table.dealerIndex = (table.dealerIndex + 1) % table.players.length;

  for (const player of table.players) {
    player.folded = player.chips <= 0 || player.online === false;
    player.bet = 0;
    player.cards = [];

    if (!player.folded) {
      player.cards.push(table.deck.pop(), table.deck.pop());
    }
  }

  const active = table.players.filter(p => !p.folded);

  if (active.length < 2) {
    table.handStarted = false;
    return false;
  }

  const smallBlindPlayer = active[0];
  const bigBlindPlayer = active[1];

  const small = Math.min(table.smallBlind, smallBlindPlayer.chips);
  const big = Math.min(table.bigBlind, bigBlindPlayer.chips);

  smallBlindPlayer.chips -= small;
  smallBlindPlayer.bet = small;
  table.pot += small;

  bigBlindPlayer.chips -= big;
  bigBlindPlayer.bet = big;
  table.pot += big;

  table.currentBet = big;
  table.currentTurn = table.players.indexOf(active[0]);
  table.currentTurn = nextPlayerIndex(table, table.currentTurn - 1);

  sendTableUpdate(table);
  sendLobby();

  return true;
}

function advanceStreet(table) {
  if (table.street === "preflop") {
    table.communityCards.push(
      table.deck.pop(),
      table.deck.pop(),
      table.deck.pop()
    );
    table.street = "flop";
  } else if (table.street === "flop") {
    table.communityCards.push(table.deck.pop());
    table.street = "turn";
  } else if (table.street === "turn") {
    table.communityCards.push(table.deck.pop());
    table.street = "river";
  } else if (table.street === "river") {
    const active = getActivePlayers(table);
    const winner = active[Math.floor(Math.random() * active.length)];
    finishHand(table, winner);
    return;
  }

  for (const player of table.players) {
    player.bet = 0;
  }

  table.currentBet = 0;
  table.currentTurn = nextPlayerIndex(table, table.dealerIndex);
  sendTableUpdate(table);
}

async function getSocketUser(socket) {
  const token = socket.handshake.auth?.token;

  if (!token) throw new Error("Нэвтрэх шаардлагатай.");

  const decoded = await admin.auth().verifyIdToken(token);
  const snap = await db.collection("users").doc(decoded.uid).get();

  if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");

  return {
    ...snap.data(),
    uid: decoded.uid
  };
}

async function refundPlayerChips(uid, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;

  const userRef = db.collection("users").doc(uid);

  await userRef.update({
    chips: FieldValue.increment(amount)
  });
}

function removePlayerFromTable(table, uid) {
  const index = table.players.findIndex(player => player.uid === uid);

  if (index < 0) return false;

  table.players.splice(index, 1);

  if (table.currentTurn >= table.players.length) {
    table.currentTurn = 0;
  }

  if (table.dealerIndex >= table.players.length) {
    table.dealerIndex = 0;
  }

  return true;
}

// ==========================================
// SOCKET CONNECTIONS
// ==========================================

io.on("connection", socket => {

  socket.on("lobby:get", async () => {
    try {
      const user = await getSocketUser(socket);

      socketUsers.set(socket.id, {
        uid: user.uid,
        tableId: null
      });

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
    const reply = result => {
      if (typeof callback === "function") callback(result);
    };

    try {
      const user = await getSocketUser(socket);
      const table = getTable(data?.tableId);

      if (!table) {
        return reply({ success: false, message: "Ширээ олдсонгүй." });
      }

      const existing = table.players.find(p => p.uid === user.uid);

      if (existing) {
        existing.online = true;

        socketUsers.set(socket.id, {
          uid: user.uid,
          tableId: table.id
        });

        socket.join("table:" + table.id);
        sendTableUpdate(table);
        sendLobby();

        return reply({
          success: true,
          table: getPublicTable(table)
        });
      }

      for (const otherTable of tables.values()) {
        if (otherTable.players.some(p => p.uid === user.uid)) {
          return reply({
            success: false,
            message: "Та өөр ширээнд суусан байна."
          });
        }
      }

      if (table.players.length >= table.maxPlayers) {
        return reply({ success: false, message: "Ширээ дүүрсэн байна." });
      }

      const buyIn = table.minBuyIn;
      const userRef = db.collection("users").doc(user.uid);

      await db.runTransaction(async transaction => {
        const snap = await transaction.get(userRef);

        if (!snap.exists) throw new Error("Хэрэглэгч олдсонгүй.");

        const balance = Number(snap.data().chips || 0);

        if (!Number.isSafeInteger(balance) || balance < buyIn) {
          throw new Error("CHIP хүрэлцэхгүй байна.");
        }

        transaction.update(userRef, { chips: balance - buyIn });
      });

      table.players.push({
        uid: user.uid,
        username: user.username || "Player",
        displayName: user.displayName || user.username || "Player",
        chips: buyIn,
        bet: 0,
        folded: false,
        online: true,
        cards: []
      });

      socketUsers.set(socket.id, {
        uid: user.uid,
        tableId: table.id
      });

      socket.join("table:" + table.id);

      sendTableUpdate(table);
      sendLobby();

      reply({
        success: true,
        table: getPublicTable(table)
      });

    } catch (error) {
      reply({
        success: false,
        message: error.message || "Ширээнд суухад алдаа гарлаа."
      });
    }
  });

  socket.on("table:leave", async () => {
    try {
      const session = socketUsers.get(socket.id);

      if (!session?.tableId) return;

      const table = getTable(session.tableId);
      if (!table) return;

      const player = table.players.find(p => p.uid === session.uid);
      if (!player) return;

      if (table.handStarted) {
        socket.emit("notice", {
          message: "Тоглолт дууссаны дараа ширээнээс гараарай."
        });
        return;
      }

      await refundPlayerChips(session.uid, player.chips);

      removePlayerFromTable(table, session.uid);
      socket.leave("table:" + table.id);
      socketUsers.delete(socket.id);

      sendTableUpdate(table);
      sendLobby();

    } catch (error) {
      socket.emit("notice", {
        message: error.message || "Ширээнээс гарахад алдаа гарлаа."
      });
    }
  });

  // ----------------------------------------
  // PLAYER ACTION
  // ----------------------------------------

  socket.on("game:action", async data => {
    try {
      const session = socketUsers.get(socket.id);
      if (!session?.tableId) return;

      const table = getTable(session.tableId);
      if (!table || !table.handStarted) return;

      const player = table.players.find(p => p.uid === session.uid);
      if (!player || player.folded) return;

      const turnPlayer = table.players[table.currentTurn];

      if (!turnPlayer || turnPlayer.uid !== session.uid) {
        socket.emit("notice", { message: "Одоо таны ээлж биш байна." });
        return;
      }

      const action = String(data?.action || "").toLowerCase();
      const amount = validAmount(data?.amount);

      if (action === "fold") {
        player.folded = true;
      } else if (action === "check") {
        if (player.bet < table.currentBet) {
          socket.emit("notice", { message: "Check хийх боломжгүй. Call эсвэл Fold хийнэ үү." });
          return;
        }
      } else if (action === "call") {
        const difference = Math.max(0, table.currentBet - player.bet);
        const paid = Math.min(difference, player.chips);

        player.chips -= paid;
        player.bet += paid;
        table.pot += paid;
      } else if (action === "raise") {
        if (!amount || amount <= table.currentBet) {
          socket.emit("notice", { message: "Raise дүн буруу байна." });
          return;
        }

        const needed = amount - player.bet;

        if (needed > player.chips) {
          socket.emit("notice", { message: "CHIP хүрэлцэхгүй байна." });
          return;
        }

        player.chips -= needed;
        player.bet = amount;
        table.pot += needed;
        table.currentBet = amount;
      } else {
        socket.emit("notice", { message: "Үйлдэл буруу байна." });
        return;
      }

      const active = getActivePlayers(table);

      if (active.length === 1) {
        finishHand(table, active[0]);
        return;
      }

      table.currentTurn = nextPlayerIndex(table, table.currentTurn);

      sendTableUpdate(table);
      sendLobby();

    } catch (error) {
      socket.emit("notice", {
        message: error.message || "Үйлдэл хийхэд алдаа гарлаа."
      });
    }
  });

  // ----------------------------------------
  // NEXT HAND / NEXT STREET
  // ----------------------------------------

  socket.on("game:next", () => {
    const session = socketUsers.get(socket.id);
    if (!session?.tableId) return;

    const table = getTable(session.tableId);
    if (!table) return;

    if (!table.handStarted) {
      startHand(table);
      return;
    }

    const active = getActivePlayers(table);

    if (active.length === 1) {
      finishHand(table, active[0]);
      return;
    }

    advanceStreet(table);
  });

  socket.on("disconnect", () => {
    const session = socketUsers.get(socket.id);

    if (session?.tableId) {
      const table = getTable(session.tableId);

      if (table) {
        const player = table.players.find(p => p.uid === session.uid);

        if (player) {
          player.online = false;
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
