
const express = require("express");
const http = require("http");
const cors = require("cors");
const admin = require("firebase-admin");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT тохируулаагүй байна.");
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT JSON буруу байна.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;

const ADMIN_UIDS = new Set(
  String(process.env.ADMIN_UIDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY || "";

function makeEmail(username) {
  return `${username}@blackclub.local`;
}

async function firebaseRequest(action, data) {
  if (!FIREBASE_WEB_API_KEY) {
    throw new Error("Firebase API key тохируулаагүй байна.");
  }

  if (typeof fetch !== "function") {
    throw new Error("Node.js 18 буюу түүнээс дээш хувилбар шаардлагатай.");
  }

  const url =
    `https://identitytoolkit.googleapis.com/v1/accounts:${action}` +
    `?key=${FIREBASE_WEB_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error("Firebase серверээс зөв хариу ирсэнгүй.");
  }

  if (!response.ok) {
    const code = result.error?.message || "";

    const messages = {
      EMAIL_EXISTS: "Энэ хэрэглэгчийн нэр бүртгэлтэй байна.",
      INVALID_PASSWORD: "Нууц үг буруу байна.",
      EMAIL_NOT_FOUND: "Хэрэглэгч олдсонгүй.",
      INVALID_LOGIN_CREDENTIALS: "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна.",
      WEAK_PASSWORD: "Нууц үг дор хаяж 8 тэмдэгт байна.",
      OPERATION_NOT_ALLOWED: "Firebase Authentication дээр Email/Password нэвтрэлтийг идэвхжүүлнэ үү.",
      API_KEY_INVALID: "Firebase API key буруу байна.",
      INVALID_API_KEY: "Firebase API key буруу байна.",
      TOO_MANY_ATTEMPTS_TRY_LATER: "Олон удаа оролдсон байна. Түр хүлээнэ үү."
    };

    console.error("Firebase authentication error:", code);

    throw new Error(
      messages[code] || "Firebase алдаа: " + code
    );
  }

  return result;
}

function validAmount(value) {
  const amount = Math.floor(Number(value));

  if (
    !Number.isSafeInteger(amount) ||
    amount < 1000 ||
    amount > 100000000
  ) {
    return 0;
  }

  return amount;
}

async function authUser(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");

    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        message: "Нэвтэрнэ үү."
      });
    }

    const decoded = await auth.verifyIdToken(token);

    const userSnap = await db
      .collection("users")
      .doc(decoded.uid)
      .get();

    if (!userSnap.exists) {
      return res.status(401).json({
        message: "Хэрэглэгч олдсонгүй."
      });
    }

    req.user = {
      uid: decoded.uid,
      ...userSnap.data()
    };

    next();

  } catch (e) {
    console.error("Auth error:", e.message);

    return res.status(401).json({
      message: "Нэвтрэх эрх хүчингүй байна."
    });
  }
}

function authAdmin(req, res, next) {
  if (!ADMIN_UIDS.has(req.user.uid)) {
    return res.status(403).json({
      message: "Админы эрх шаардлагатай."
    });
  }

  next();
}

function cleanUser(u) {
  return {
    id: u.uid,
    username: u.username,
    displayName: u.displayName,
    chips: Number(u.chips || 0),
    bankName: u.bankName || "",
    bankAccount: u.bankAccount || "",
    bankHolder: u.bankHolder || "",
    phone: u.phone || "",
    isAdmin: ADMIN_UIDS.has(u.uid)
  };
}

// ===============================
// REGISTER
// ===============================

app.post("/api/register", async (req, res) => {
  let createdUid = null;

  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const displayName = String(
      req.body.displayName || username
    ).trim();

    const password = String(req.body.password || "");

    const confirmPassword = String(
      req.body.confirmPassword || ""
    );

    const bankName = String(req.body.bankName || "").trim();
    const bankAccount = String(req.body.bankAccount || "")
      .trim()
      .replace(/\s+/g, "");
    const bankHolder = String(req.body.bankHolder || "").trim();
    const phone = String(req.body.phone || "").trim();

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({
        message: "Хэрэглэгчийн нэр 3-24 тэмдэгт байна."
      });
    }

    if (displayName.length < 2 || displayName.length > 18) {
      return res.status(400).json({
        message: "Тоглоомын нэр 2-18 тэмдэгт байна."
      });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        message: "Нууц үг 8-72 тэмдэгт байх ёстой."
      });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        message: "Нууц үг таарахгүй байна."
      });
    }

    const usernameRef = db.collection("usernames").doc(username);
    const existing = await usernameRef.get();

    if (existing.exists) {
      return res.status(409).json({
        message: "Энэ хэрэглэгчийн нэр бүртгэлтэй байна."
      });
    }

    const account = await firebaseRequest("signUp", {
      email: makeEmail(username),
      password,
      returnSecureToken: true
    });

    createdUid = account.localId;

    const userRef = db.collection("users").doc(createdUid);

    const newUser = {
      uid: createdUid,
      username,
      displayName,
      chips: 0,
      bankName,
      bankAccount,
      bankHolder,
      phone,
      createdAt: FieldValue.serverTimestamp()
    };

    await db.runTransaction(async tx => {
      const check = await tx.get(usernameRef);

      if (check.exists) {
        throw new Error("Энэ хэрэглэгчийн нэр бүртгэлтэй байна.");
      }

      tx.set(usernameRef, {
        uid: createdUid,
        username
      });

      tx.set(userRef, newUser);
    });

    res.json({
      success: true,
      token: account.idToken,
      user: cleanUser({
        ...newUser,
        uid: createdUid
      })
    });

  } catch (e) {
    if (createdUid) {
      try {
        await auth.deleteUser(createdUid);
      } catch (cleanupError) {
        console.error("Register cleanup:", cleanupError);
      }
    }

    console.error("Register error:", e);

    res.status(
      e.message.includes("бүртгэлтэй") ? 409 : 400
    ).json({
      message: e.message || "Бүртгэл үүсгэхэд алдаа гарлаа."
    });
  }
});

// ===============================
// LOGIN
// ===============================

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        message: "Нэр болон нууц үгээ оруулна уу."
      });
    }

    const result = await firebaseRequest("signInWithPassword", {
      email: makeEmail(username),
      password,
      returnSecureToken: true
    });

    const userSnap = await db
      .collection("users")
      .doc(result.localId)
      .get();

    if (!userSnap.exists) {
      return res.status(404).json({
        message: "Хэрэглэгчийн мэдээлэл олдсонгүй."
      });
    }

    res.json({
      success: true,
      token: result.idToken,
      user: cleanUser({
        uid: result.localId,
        ...userSnap.data()
      })
    });

  } catch (e) {
    console.error("Login error:", e.message);

    res.status(401).json({
      message: "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна."
    });
  }
});

// ===============================
// CURRENT USER
// ===============================

app.get("/api/me", authUser, async (req, res) => {
  try {
    const snap = await db
      .collection("users")
      .doc(req.user.uid)
      .get();

    res.json({
      success: true,
      user: cleanUser({
        uid: req.user.uid,
        ...snap.data()
      })
    });

  } catch (e) {
    console.error("Current user:", e);

    res.status(500).json({
      message: "Хэрэглэгчийн мэдээлэл авахад алдаа гарлаа."
    });
  }
});

// ===============================
// UPDATE PROFILE
// ===============================

app.post("/api/profile/update", authUser, async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim();
    const bankName = String(req.body.bankName || "").trim();
    const bankAccount = String(req.body.bankAccount || "")
      .trim()
      .replace(/\s+/g, "");
    const bankHolder = String(req.body.bankHolder || "").trim();
    const phone = String(req.body.phone || "").trim();

    if (displayName.length < 2 || displayName.length > 18) {
      return res.status(400).json({
        message: "Тоглоомын нэр 2-18 тэмдэгт байна."
      });
    }

    const userRef = db.collection("users").doc(req.user.uid);

    await userRef.set({
      displayName,
      bankName,
      bankAccount,
      bankHolder,
      phone,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const snap = await userRef.get();

    res.json({
      success: true,
      user: cleanUser({
        uid: req.user.uid,
        ...snap.data()
      })
    });

  } catch (e) {
    console.error("Profile update:", e);

    res.status(500).json({
      message: "Профайл хадгалахад алдаа гарлаа."
    });
  }
});

// ===============================
// CASHIER HELPERS
// ===============================

function publicRequest(d) {
  return {
    id: d.id,
    uid: d.uid,
    username: d.username || "",
    displayName: d.displayName || "",
    type: d.type,
    amount: Number(d.amount || 0),
    status: d.status,
    reference: d.reference || "",
    bankName: d.bankName || "",
    bankAccount: d.bankAccount || "",
    bankHolder: d.bankHolder || "",
    phone: d.phone || "",
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null,
    decidedAt: d.decidedAt?.toDate?.()?.toISOString?.() || null,
    adminNote: d.adminNote || ""
  };
}

// ===============================
// CASHIER INFO
// ===============================

app.get("/api/cashier/info", authUser, async (req, res) => {
  try {
    res.json({
      success: true,
      bankName: process.env.CASHIER_BANK_NAME || "",
      bankAccount: process.env.CASHIER_BANK_ACCOUNT || "",
      bankHolder: process.env.CASHIER_BANK_HOLDER || "",
      user: cleanUser(req.user)
    });
  } catch (e) {
    console.error("Cashier info:", e);

    res.status(500).json({
      message: "Кассын мэдээлэл авахад алдаа гарлаа."
    });
  }
});

// ===============================
// DEPOSIT REQUEST
// ===============================

app.post("/api/cashier/deposit", authUser, async (req, res) => {
  try {
    const amount = validAmount(req.body.amount);

    const reference = String(req.body.reference || "")
      .trim()
      .slice(0, 120);

    if (!amount) {
      return res.status(400).json({
        message: "Дүн 1,000-100,000,000 CHIP байна."
      });
    }

    if (!reference) {
      return res.status(400).json({
        message: "Гүйлгээний утга эсвэл баримтын дугаар оруулна уу."
      });
    }

    const userSnap = await db
      .collection("users")
      .doc(req.user.uid)
      .get();

    if (!userSnap.exists) {
      return res.status(404).json({
        message: "Хэрэглэгч олдсонгүй."
      });
    }

    const u = userSnap.data();
    const ref = db.collection("cashierRequests").doc();

    await ref.set({
      uid: req.user.uid,
      username: u.username,
      displayName: u.displayName,
      type: "deposit",
      amount,
      reference,
      status: "pending",
      bankName: u.bankName || "",
      bankAccount: u.bankAccount || "",
      bankHolder: u.bankHolder || "",
      phone: u.phone || "",
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Цэнэглэх хүсэлт админд илгээгдлээ.",
      requestId: ref.id
    });

  } catch (e) {
    console.error("Deposit error:", e);

    res.status(500).json({
      message: "Цэнэглэх хүсэлт илгээхэд алдаа гарлаа."
    });
  }
});

// ===============================
// WITHDRAW REQUEST
// ===============================

app.post("/api/cashier/withdraw", authUser, async (req, res) => {
  try {
    const amount = validAmount(req.body.amount);

    if (!amount) {
      return res.status(400).json({
        message: "Дүн 1,000-100,000,000 CHIP байна."
      });
    }

    const userRef = db.collection("users").doc(req.user.uid);
    const requestRef = db.collection("cashierRequests").doc();

    await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);

      if (!snap.exists) {
        throw new Error("Хэрэглэгч олдсонгүй.");
      }

      const u = snap.data();
      const chips = Number(u.chips || 0);

      if (chips < amount) {
        throw new Error("CHIP хүрэлцэхгүй байна.");
      }

      if (!u.bankName || !u.bankAccount || !u.bankHolder || !u.phone) {
        throw new Error("Банкны мэдээллээ профайлд бүрэн оруулна уу.");
      }

      tx.update(userRef, {
        chips: chips - amount,
        updatedAt: FieldValue.serverTimestamp()
      });

      tx.set(requestRef, {
        uid: req.user.uid,
        username: u.username,
        displayName: u.displayName,
        type: "withdraw",
        amount,
        status: "pending",
        bankName: u.bankName,
        bankAccount: u.bankAccount,
        bankHolder: u.bankHolder,
        phone: u.phone,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Татах хүсэлт илгээгдлээ.",
      requestId: requestRef.id
    });

  } catch (e) {
    console.error("Withdraw error:", e);

    res.status(400).json({
      message: e.message || "Татах хүсэлтэд алдаа гарлаа."
    });
  }
});

// ===============================
// USER CASHIER HISTORY
// ===============================

app.get("/api/cashier/history", authUser, async (req, res) => {
  try {
    const snap = await db
      .collection("cashierRequests")
      .where("uid", "==", req.user.uid)
      .get();

    const requests = snap.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .sort((a, b) => {
        const at = a.createdAt?.toMillis?.() || 0;
        const bt = b.createdAt?.toMillis?.() || 0;
        return bt - at;
      });

    res.json({
      success: true,
      requests: requests.map(publicRequest)
    });

  } catch (e) {
    console.error("Cashier history:", e);

    res.status(500).json({
      message: "Гүйлгээний түүх авахад алдаа гарлаа."
    });
  }
});

// ===============================
// ADMIN CASHIER LIST
// ===============================

app.get(
  "/api/admin/cashier/list",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const snap = await db
        .collection("cashierRequests")
        .get();

      const requests = snap.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data()
        }))
        .sort((a, b) => {
          const at = a.createdAt?.toMillis?.() || 0;
          const bt = b.createdAt?.toMillis?.() || 0;
          return bt - at;
        });

      res.json({
        success: true,
        requests: requests.map(publicRequest)
      });

    } catch (e) {
      console.error("Admin cashier list:", e);

      res.status(500).json({
        message: "Хүсэлтүүдийг авахад алдаа гарлаа."
      });
    }
  }
);

// ===============================
// ADMIN CASHIER DECISION
// ===============================

app.post(
  "/api/admin/cashier/decision",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const requestId = String(req.body.requestId || "").trim();
      const decision = String(req.body.decision || "").trim();
      const note = String(req.body.note || "").trim().slice(0, 300);

      if (!requestId || !["approve", "reject"].includes(decision)) {
        return res.status(400).json({
          message: "Хүсэлтийн мэдээлэл буруу байна."
        });
      }

      const requestRef = db
        .collection("cashierRequests")
        .doc(requestId);

      await db.runTransaction(async tx => {
        const requestSnap = await tx.get(requestRef);

        if (!requestSnap.exists) {
          throw new Error("Хүсэлт олдсонгүй.");
        }

        const request = requestSnap.data();

        if (request.status !== "pending") {
          throw new Error("Энэ хүсэлтийг өмнө нь шийдвэрлэсэн байна.");
        }

        const userRef = db
          .collection("users")
          .doc(request.uid);

        const userSnap = await tx.get(userRef);

        if (!userSnap.exists) {
          throw new Error("Хэрэглэгч олдсонгүй.");
        }

        const user = userSnap.data();
        const amount = Number(request.amount || 0);

        if (request.type === "deposit" && decision === "approve") {
          tx.update(userRef, {
            chips: Number(user.chips || 0) + amount,
            updatedAt: FieldValue.serverTimestamp()
          });
        }

        if (request.type === "withdraw" && decision === "reject") {
          tx.update(userRef, {
            chips: Number(user.chips || 0) + amount,
            updatedAt: FieldValue.serverTimestamp()
          });
        }

        tx.update(requestRef, {
          status: decision === "approve" ? "approved" : "rejected",
          adminNote: note,
          decidedBy: req.user.uid,
          decidedAt: FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: decision === "approve"
          ? "Хүсэлт баталгаажлаа."
          : "Хүсэлтээс татгалзлаа."
      });

    } catch (e) {
      console.error("Admin decision:", e);

      res.status(400).json({
        message: e.message || "Хүсэлт шийдвэрлэхэд алдаа гарлаа."
      });
    }
  }
);

// ===============================
// ADMIN USER LIST
// ===============================

app.get(
  "/api/admin/users",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const snap = await db.collection("users").get();

      const users = snap.docs.map(doc => {
        const data = doc.data();

        return {
          id: doc.id,
          username: data.username || "",
          displayName: data.displayName || "",
          chips: Number(data.chips || 0),
          bankName: data.bankName || "",
          bankAccount: data.bankAccount || "",
          bankHolder: data.bankHolder || "",
          phone: data.phone || "",
          isAdmin: ADMIN_UIDS.has(doc.id)
        };
      });

      res.json({
        success: true,
        users
      });

    } catch (e) {
      console.error("Admin users:", e);

      res.status(500).json({
        message: "Хэрэглэгчдийн жагсаалт авахад алдаа гарлаа."
      });
    }
  }
);

// ===============================
// ADMIN CHIP ADJUSTMENT
// ===============================

app.post(
  "/api/admin/chips",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const uid = String(req.body.uid || "").trim();
      const amount = Math.floor(Number(req.body.amount));
      const action = String(req.body.action || "");

      if (!uid || !Number.isSafeInteger(amount) || amount <= 0) {
        return res.status(400).json({
          message: "Хэрэглэгч болон CHIP дүн буруу байна."
        });
      }

      if (!["add", "remove"].includes(action)) {
        return res.status(400).json({
          message: "Үйлдэл буруу байна."
        });
      }

      const userRef = db.collection("users").doc(uid);

      await db.runTransaction(async tx => {
        const snap = await tx.get(userRef);

        if (!snap.exists) {
          throw new Error("Хэрэглэгч олдсонгүй.");
        }

        const user = snap.data();
        const oldChips = Number(user.chips || 0);

        if (action === "remove" && oldChips < amount) {
          throw new Error("Хэрэглэгчийн CHIP хүрэлцэхгүй байна.");
        }

        tx.update(userRef, {
          chips: action === "add"
            ? oldChips + amount
            : oldChips - amount,
          updatedAt: FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: "CHIP шинэчлэгдлээ."
      });

    } catch (e) {
      console.error("Admin CHIP:", e);

      res.status(400).json({
        message: e.message || "CHIP өөрчлөхөд алдаа гарлаа."
      });
    }
  }
);

// =====================================
// POKER TABLE SYSTEM
// =====================================

const TABLE_CONFIG = [
  {
    id: "table1",
    name: "BEGINNER",
    smallBlind: 50,
    bigBlind: 100,
    minBuyIn: 1000,
    maxBuyIn: 10000,
    maxPlayers: 6
  },
  {
    id: "table2",
    name: "SILVER",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 2000,
    maxBuyIn: 20000,
    maxPlayers: 6
  },
  {
    id: "table3",
    name: "GOLD",
    smallBlind: 500,
    bigBlind: 1000,
    minBuyIn: 10000,
    maxBuyIn: 100000,
    maxPlayers: 6
  },
  {
    id: "table4",
    name: "BLACK",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: 20000,
    maxBuyIn: 200000,
    maxPlayers: 6
  }
];

const tables = new Map();

for (const config of TABLE_CONFIG) {
  tables.set(config.id, {
    ...config,
    players: [],
    communityCards: [],
    pot: 0,
    currentTurn: null,
    dealerIndex: 0,
    handStarted: false,
    status: "waiting"
  });
}

const socketUsers = new Map();

function getTable(tableId) {
  return tables.get(String(tableId));
}

function getPublicTable(table) {
  return {
    id: table.id,
    name: table.name,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    maxPlayers: table.maxPlayers,

    players: table.players.map(player => ({
      id: player.uid,
      username: player.username,
      displayName: player.displayName,
      chips: player.chips,
      avatar: player.avatar || "",
      seat: player.seat,
      online: player.online !== false,
      folded: !!player.folded,
      isDealer: !!player.isDealer,
      isTurn: table.currentTurn === player.uid
    })),

    communityCards: table.communityCards,
    pot: table.pot,
    currentTurn: table.currentTurn,
    status: table.status
  };
}

function sendLobby() {
  const result = Array.from(tables.values()).map(getPublicTable);

  io.emit("lobby:update", {
    tables: result
  });
}

function sendTableUpdate(table) {
  io.to(table.id).emit("table:update", {
    table: getPublicTable(table)
  });

  sendLobby();
}

function removePlayerFromTable(socket, notify = true) {
  const info = socketUsers.get(socket.id);

  if (!info) return;

  const table = getTable(info.tableId);

  if (table) {
    table.players = table.players.filter(
      player => player.uid !== info.uid
    );

    if (table.currentTurn === info.uid) {
      table.currentTurn = null;
    }

    if (table.players.length === 0) {
      table.communityCards = [];
      table.pot = 0;
      table.handStarted = false;
      table.status = "waiting";
    }

    if (notify) {
      sendTableUpdate(table);
    }
  }

  if (info.tableId) {
    socket.leave(info.tableId);
  }

  socketUsers.delete(socket.id);
}

// =====================================
// SOCKET CONNECTION
// =====================================

io.on("connection", socket => {

  socket.on("lobby:get", async () => {
    try {
      const token = socket.handshake.auth?.token;

      if (token) {
        const decoded = await auth.verifyIdToken(token);

        socketUsers.set(socket.id, {
          uid: decoded.uid,
          tableId: null
        });
      }

      sendLobby();

    } catch (e) {
      console.error("Lobby authentication:", e.message);

      socket.emit("notice", {
        message: "Нэвтрэх мэдээлэл хүчингүй байна."
      });
    }
  });

  // ===================================
  // JOIN TABLE
  // ===================================

  socket.on("table:join", async data => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return socket.emit("notice", {
          message: "Эхлээд нэвтэрнэ үү."
        });
      }

      const decoded = await auth.verifyIdToken(token);
      const uid = decoded.uid;

      const table = getTable(data?.tableId);

      if (!table) {
        return socket.emit("notice", {
          message: "Ширээ олдсонгүй."
        });
      }

      const userSnap = await db
        .collection("users")
        .doc(uid)
        .get();

      if (!userSnap.exists) {
        return socket.emit("notice", {
          message: "Хэрэглэгч олдсонгүй."
        });
      }

      const user = userSnap.data();

      const alreadyPlaying = Array.from(tables.values())
        .some(t => t.players.some(p => p.uid === uid));

      if (alreadyPlaying) {
        return socket.emit("notice", {
          message: "Та аль хэдийн ширээнд суусан байна."
        });
      }

      if (table.players.length >= table.maxPlayers) {
        return socket.emit("notice", {
          message: "Ширээ дүүрсэн байна."
        });
      }

      const buyIn = Math.floor(Number(data?.buyIn));

      if (
        !Number.isSafeInteger(buyIn) ||
        buyIn < table.minBuyIn ||
        buyIn > table.maxBuyIn
      ) {
        return socket.emit("notice", {
          message: "Оруулах CHIP дүн тохирохгүй байна."
        });
      }

      const userRef = db.collection("users").doc(uid);

      await db.runTransaction(async tx => {
        const snap = await tx.get(userRef);

        if (!snap.exists) {
          throw new Error("Хэрэглэгч олдсонгүй.");
        }

        const current = Number(snap.data().chips || 0);

        if (current < buyIn) {
          throw new Error("CHIP хүрэлцэхгүй байна.");
        }

        tx.update(userRef, {
          chips: current - buyIn,
          updatedAt: FieldValue.serverTimestamp()
        });
      });

      const seat = Array.from(
        { length: table.maxPlayers },
        (_, i) => i
      ).find(index =>
        !table.players.some(player => player.seat === index)
      );

      const player = {
        uid,
        username: user.username,
        displayName: user.displayName,
        chips: buyIn,
        avatar: "",
        seat,
        online: true,
        folded: false,
        isDealer: false
      };

      table.players.push(player);

      socketUsers.set(socket.id, {
        uid,
        tableId: table.id
      });

      socket.join(table.id);

      socket.emit("table:update", {
        table: getPublicTable(table)
      });

      sendTableUpdate(table);

    } catch (e) {
      console.error("Table join:", e);

      socket.emit("notice", {
        message: e.message || "Ширээнд ороход алдаа гарлаа."
      });
    }
  });

  // ===================================
  // LEAVE TABLE
  // ===================================

  socket.on("table:leave", async () => {
    try {
      const info = socketUsers.get(socket.id);

      if (!info || !info.tableId) return;

      const table = getTable(info.tableId);

      if (!table) {
        socketUsers.delete(socket.id);
        return;
      }

      const player = table.players.find(
        p => p.uid === info.uid
      );

      if (player) {
        const userRef = db.collection("users").doc(info.uid);

        await userRef.update({
          chips: FieldValue.increment(player.chips),
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      removePlayerFromTable(socket);

    } catch (e) {
      console.error("Table leave:", e);

      socket.emit("notice", {
        message: "Ширээнээс гарахад алдаа гарлаа."
      });
    }
  });

  // ===================================
  // DISCONNECT
  // ===================================

  socket.on("disconnect", () => {
    const info = socketUsers.get(socket.id);

    if (!info) return;

    const table = getTable(info.tableId);

    if (table) {
      const player = table.players.find(
        p => p.uid === info.uid
      );

      if (player) {
        player.online = false;
        sendTableUpdate(table);
      }
    }

    socketUsers.delete(socket.id);
  });

});

 // =====================================
 // POKER GAME HELPERS
 // =====================================

const SUITS = ["♠", "♥", "♦", "♣"];

const RANKS = [
  "2", "3", "4", "5", "6", "7", "8",
  "9", "10", "J", "Q", "K", "A"
];

function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function resetPlayer(player) {
  player.folded = false;
  player.bet = 0;
  player.cards = [];
  player.online = true;
}

function startHand(table) {
  const active = table.players.filter(p => p.chips > 0);

  if (active.length < 2) {
    table.status = "waiting";
    table.handStarted = false;
    return false;
  }

  const deck = createDeck();

  table.deck = deck;
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = 0;
  table.handStarted = true;
  table.status = "preflop";

  table.players.forEach(resetPlayer);

  for (let i = 0; i < 2; i++) {
    active.forEach(player => {
      player.cards.push(table.deck.pop());
    });
  }

  table.dealerIndex =
    (table.dealerIndex + 1) % active.length;

  const dealer = active[table.dealerIndex];

  table.players.forEach(p => {
    p.isDealer = p.uid === dealer.uid;
  });

  table.currentTurn = active[0].uid;

  sendTableUpdate(table);

  return true;
}

function nextTurn(table) {
  const active = table.players.filter(
    p => !p.folded && p.chips > 0
  );

  if (active.length <= 1) {
    finishHand(table);
    return;
  }

  const currentIndex = active.findIndex(
    p => p.uid === table.currentTurn
  );

  const nextIndex = (currentIndex + 1) % active.length;

  table.currentTurn = active[nextIndex].uid;

  sendTableUpdate(table);
}

function finishHand(table) {
  const active = table.players.filter(p => !p.folded);

  if (active.length === 1) {
    active[0].chips += table.pot;
  } else if (active.length > 1) {
    const winner = active[
      Math.floor(Math.random() * active.length)
    ];

    winner.chips += table.pot;
  }

  table.pot = 0;
  table.currentTurn = null;
  table.handStarted = false;
  table.status = "waiting";

  table.players.forEach(player => {
    player.cards = [];
    player.folded = false;
    player.bet = 0;
  });

  sendTableUpdate(table);
}

// =====================================
// GAME ACTION
// =====================================

io.on("connection", socket => {

  socket.on("game:action", async data => {
    try {
      const info = socketUsers.get(socket.id);

      if (!info || !info.tableId) {
        return socket.emit("notice", {
          message: "Та ширээнд суугаагүй байна."
        });
      }

      const table = getTable(info.tableId);

      if (!table || !table.handStarted) {
        return socket.emit("notice", {
          message: "Тоглолт эхлээгүй байна."
        });
      }

      if (table.currentTurn !== info.uid) {
        return socket.emit("notice", {
          message: "Таны ээлж биш байна."
        });
      }

      const player = table.players.find(
        p => p.uid === info.uid
      );

      if (!player) return;

      const action = String(data?.action || "");

      if (action === "fold") {
        player.folded = true;
        nextTurn(table);
        return;
      }

      if (action === "check") {
        nextTurn(table);
        return;
      }

      if (action === "call") {
        const difference = Math.max(
          0,
          Number(table.currentBet || 0) -
          Number(player.bet || 0)
        );

        const amount = Math.min(
          difference,
          player.chips
        );

        player.chips -= amount;
        player.bet = Number(player.bet || 0) + amount;
        table.pot += amount;

        nextTurn(table);
        return;
      }

      if (action === "raise") {
        const raiseAmount = Math.floor(
          Number(data?.amount)
        );

        if (
          !Number.isSafeInteger(raiseAmount) ||
          raiseAmount <= 0 ||
          raiseAmount > player.chips
        ) {
          return socket.emit("notice", {
            message: "Бооцооны дүн буруу байна."
          });
        }

        player.chips -= raiseAmount;
        player.bet = Number(player.bet || 0) + raiseAmount;
        table.pot += raiseAmount;
        table.currentBet = player.bet;

        nextTurn(table);
        return;
      }

      socket.emit("notice", {
        message: "Тоглоомын үйлдэл буруу байна."
      });

    } catch (e) {
      console.error("Game action:", e);

      socket.emit("notice", {
        message: "Тоглоомын үйлдэлд алдаа гарлаа."
      });
    }
  });

  // ===================================
  // NEXT HAND
  // ===================================

  socket.on("game:next", () => {
    const info = socketUsers.get(socket.id);

    if (!info || !info.tableId) return;

    const table = getTable(info.tableId);

    if (!table || table.handStarted) return;

    if (table.players.length < 2) {
      return socket.emit("notice", {
        message: "Тоглолт эхлүүлэхэд 2 тоглогч хэрэгтэй."
      });
    }

    startHand(table);
  });

});

// =====================================
// HEALTH CHECK
// =====================================

app.get("/", (req, res) => {
  res.send("BLACKCLUB Poker Server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    time: new Date().toISOString()
  });
});

// =====================================
// START SERVER
// =====================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BLACKCLUB server running on port ${PORT}`);
});
