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

const ALLOWED_BANKS = [
  "Хаан банк",
  "Худалдаа хөгжлийн банк",
  "ХасБанк",
  "Төрийн банк",
  "Голомт банк",
  "Капитрон банк"
];

// ==========================================
// FIREBASE
// ==========================================

if (!admin.apps.length) {
  const serviceAccountText =
    process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccountText) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT тохируулаагүй байна."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(serviceAccountText);
  } catch (error) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT JSON буруу байна."
    );
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
  return String(username).trim().toLowerCase()
    + "@blackclub.local";
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(
    String(username || "")
  );
}

function validAmount(value) {
  const amount = Number(value);

  return Number.isSafeInteger(amount) && amount > 0
    ? amount
    : 0;
}

function cleanUser(data, uid) {
  const userId = uid || data.uid;
  const isAdmin = ADMIN_UIDS.includes(userId);

  return {
    uid: userId,
    username: data.username || "",
    displayName: data.displayName || data.username || "",
    chips: Number(data.chips || 0),
    role: isAdmin ? "admin" : "user",
    isAdmin,
    bankName: data.bankName || "",
    bankAccount: data.bankAccount || "",
    bankHolder: data.bankHolder || "",
    ageConfirmed: data.ageConfirmed === true
  };
}

// ==========================================
// FIREBASE AUTH REQUEST
// ==========================================

async function firebaseRequest(endpoint, body) {
  if (!FIREBASE_WEB_API_KEY) {
    throw new Error(
      "FIREBASE_WEB_API_KEY тохируулаагүй байна."
    );
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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

    throw new Error(
      messages[code] || "Нэвтрэлт амжилтгүй боллоо."
    );
  }

  return result;
}

// ==========================================
// USER AUTHENTICATION
// ==========================================

async function authUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({
        message: "Нэвтрэх шаардлагатай."
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const userRef = db.collection("users").doc(decoded.uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(401).json({
        message: "Хэрэглэгч олдсонгүй."
      });
    }

    req.auth = decoded;

    req.user = {
      ...snap.data(),
      uid: decoded.uid
    };

    req.userRef = userRef;

    next();

  } catch (error) {
    return res.status(401).json({
      message:
        "Нэвтрэх эрх хүчингүй эсвэл хугацаа дууссан байна."
    });
  }
}

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function authAdmin(req, res, next) {
  const allowed = ADMIN_UIDS.includes(req.user.uid);

  if (!allowed) {
    return res.status(403).json({
      message: "Админ эрх шаардлагатай."
    });
  }

  next();
}

// ==========================================
// CASHIER PUBLIC DATA
// ==========================================

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
  let createdUid = null;

  try {
    const username = normalizeUsername(req.body.username);

    const displayName = String(
      req.body.displayName || username
    ).trim();

    const password = String(req.body.password || "");
    const confirmPassword = req.body.confirmPassword;

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

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        message: "Нууц үг таарахгүй байна."
      });
    }

    if (!ALLOWED_BANKS.includes(bankName)) {
      return res.status(400).json({
        message: "Банкны мэдээллээ зөв сонгоно уу."
      });
    }

    if (!/^[0-9]{6,20}$/.test(bankAccount)) {
      return res.status(400).json({
        message: "Дансны дугаар 6-20 оронтой байх ёстой."
      });
    }

    if (bankHolder.length < 2 || bankHolder.length > 60) {
      return res.status(400).json({
        message: "Данс эзэмшигчийн нэр 2-60 тэмдэгт байх ёстой."
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

    const account = await firebaseRequest("accounts:signUp", {
      email: makeEmail(username),
      password,
      returnSecureToken: true
    });

    createdUid = account.localId;

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

    await db.runTransaction(async transaction => {
      const usernameSnap = await transaction.get(usernameRef);

      if (usernameSnap.exists) {
        throw new Error(
          "Энэ хэрэглэгчийн нэр бүртгэлтэй байна."
        );
      }

      transaction.set(usernameRef, {
        uid: createdUid,
        username
      });

      transaction.set(
        db.collection("users").doc(createdUid),
        userData
      );
    });

    return res.status(201).json({
      success: true,
      token: account.idToken,
      refreshToken: account.refreshToken,
      user: cleanUser(userData, createdUid)
    });

  } catch (error) {
    if (createdUid) {
      try {
        await admin.auth().deleteUser(createdUid);
      } catch (deleteError) {
        console.error(
          "Firebase хэрэглэгч цэвэрлэхэд алдаа:",
          deleteError
        );
      }
    }

    console.error("REGISTER ERROR:", error);

    return res.status(400).json({
      message: error.message ||
        "Бүртгэл үүсгэхэд алдаа гарлаа."
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
      message: error.message ||
        "Хэрэглэгчийн нэр эсвэл нууц үг буруу байна."
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
// ADMIN CHECK
// ==========================================

app.get("/api/admin/me", authUser, authAdmin, (req, res) => {
  res.json({
    success: true,
    isAdmin: true,
    uid: req.user.uid
  });
});

// ==========================================
// PROFILE UPDATE
// ==========================================

app.post("/api/profile/update", authUser, async (req, res) => {
  try {
    const displayName = String(
      req.body.displayName || ""
    ).trim();

    const bankName = String(
      req.body.bankName || ""
    ).trim();

    const bankAccount = String(
      req.body.bankAccount || ""
    ).trim();

    const bankHolder = String(
      req.body.bankHolder || ""
    ).trim();

    if (displayName.length > 40) {
      return res.status(400).json({
        message: "Нэр 40 тэмдэгтээс хэтэрч болохгүй."
      });
    }

    if (!ALLOWED_BANKS.includes(bankName)) {
      return res.status(400).json({
        message: "Банкны мэдээллээ зөв сонгоно уу."
      });
    }

    if (!/^[0-9]{6,20}$/.test(bankAccount)) {
      return res.status(400).json({
        message: "Дансны дугаар 6-20 оронтой байх ёстой."
      });
    }

    if (bankHolder.length < 2 || bankHolder.length > 60) {
      return res.status(400).json({
        message: "Данс эзэмшигчийн нэр буруу байна."
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
    res.status(500).json({
      message: "Мэдээлэл хадгалахад алдаа гарлаа."
    });
  }
});
// ==========================================
// CASHIER WITHDRAW
// ==========================================

app.post("/api/cashier/withdraw", authUser, async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({
        message: "Мөнгөн дүн буруу байна."
      });
    }

    if (amount < 1000) {
      return res.status(400).json({
        message: "Таталтын доод хэмжээ 1,000 чип."
      });
    }

    const userRef = req.userRef;
    const requestRef = db.collection("cashierRequests").doc();

    await db.runTransaction(async transaction => {
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) {
        throw new Error("Хэрэглэгч олдсонгүй.");
      }

      const user = userSnap.data();
      const currentChips = Number(user.chips || 0);

      if (currentChips < amount) {
        throw new Error("Чипийн үлдэгдэл хүрэлцэхгүй байна.");
      }

      transaction.update(userRef, {
        chips: currentChips - amount
      });

      transaction.set(requestRef, {
        id: requestRef.id,
        uid: req.user.uid,
        username: user.username || "",
        displayName: user.displayName || "",
        type: "withdraw",
        amount,
        bankName: user.bankName || "",
        bankAccount: user.bankAccount || "",
        bankHolder: user.bankHolder || "",
        status: "pending",
        adminNote: "",
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Таталтын хүсэлт илгээгдлээ.",
      requestId: requestRef.id
    });

  } catch (error) {
    res.status(400).json({
      message: error.message || "Таталтын хүсэлт амжилтгүй."
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

    const requests = snap.docs.map(doc =>
      publicRequest(doc.data())
    );

    requests.sort((a, b) => {
      const aTime = a.createdAt?._seconds || 0;
      const bTime = b.createdAt?._seconds || 0;
      return bTime - aTime;
    });

    res.json({ requests });

  } catch (error) {
    console.error("CASHIER HISTORY ERROR:", error);

    res.status(500).json({
      message: "Гүйлгээний түүх авахад алдаа гарлаа."
    });
  }
});

// ==========================================
// ADMIN CASHIER LIST
// ==========================================

app.get(
  "/api/admin/cashier/list",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const snap = await db.collection("cashierRequests")
        .limit(200)
        .get();

      const requests = snap.docs.map(doc =>
        publicRequest(doc.data())
      );

      requests.sort((a, b) => {
        const aTime = a.createdAt?._seconds || 0;
        const bTime = b.createdAt?._seconds || 0;
        return bTime - aTime;
      });

      res.json({ requests });

    } catch (error) {
      console.error("ADMIN CASHIER LIST ERROR:", error);

      res.status(500).json({
        message: "Хүсэлтүүдийг авахад алдаа гарлаа."
      });
    }
  }
);

// ==========================================
// ADMIN CASHIER DECISION
// ==========================================

app.post(
  "/api/admin/cashier/decision",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const requestId = String(req.body.requestId || "").trim();
      const decision = String(req.body.decision || "").trim();
      const adminNote = String(req.body.adminNote || "").trim();

      if (!requestId || !["approve", "reject"].includes(decision)) {
        return res.status(400).json({
          message: "Хүсэлтийн мэдээлэл буруу байна."
        });
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

        if (decision === "reject" && request.type === "withdraw") {
          const user = userSnap.data();

          transaction.update(userRef, {
            chips: Number(user.chips || 0) + Number(request.amount || 0)
          });
        }

        if (decision === "approve" && request.type === "deposit") {
          const user = userSnap.data();

          transaction.update(userRef, {
            chips: Number(user.chips || 0) + Number(request.amount || 0)
          });
        }

        transaction.update(requestRef, {
          status: decision === "approve" ? "approved" : "rejected",
          adminNote,
          decidedBy: req.user.uid,
          decidedAt: FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: decision === "approve"
          ? "Хүсэлт баталгаажлаа."
          : "Хүсэлт буцаагдлаа."
      });

    } catch (error) {
      console.error("CASHIER DECISION ERROR:", error);

      res.status(400).json({
        message: error.message || "Хүсэлт шийдвэрлэхэд алдаа гарлаа."
      });
    }
  }
);

// ==========================================
// ADMIN USERS
// ==========================================

app.get(
  "/api/admin/users",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const snap = await db.collection("users")
        .limit(200)
        .get();

      const users = snap.docs.map(doc =>
        cleanUser(doc.data(), doc.id)
      );

      res.json({ users });

    } catch (error) {
      console.error("ADMIN USERS ERROR:", error);

      res.status(500).json({
        message: "Хэрэглэгчдийн жагсаалт авахад алдаа гарлаа."
      });
    }
  }
);

// ==========================================
// ADMIN ADD / REMOVE CHIPS
// ==========================================

app.post(
  "/api/admin/chips",
  authUser,
  authAdmin,
  async (req, res) => {
    try {
      const targetUid = String(req.body.uid || "").trim();
      const amount = Number(req.body.amount);
      const action = String(req.body.action || "").trim();

      if (
        !targetUid ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          message: "Хэрэглэгч эсвэл чипийн хэмжээ буруу байна."
        });
      }

      if (!["add", "remove"].includes(action)) {
        return res.status(400).json({
          message: "Үйлдэл буруу байна."
        });
      }

      const targetRef = db.collection("users").doc(targetUid);

      let newChips = 0;

      await db.runTransaction(async transaction => {
        const snap = await transaction.get(targetRef);

        if (!snap.exists) {
          throw new Error("Хэрэглэгч олдсонгүй.");
        }

        const user = snap.data();
        const currentChips = Number(user.chips || 0);

        if (action === "remove" && currentChips < amount) {
          throw new Error("Хэрэглэгчийн чип хүрэлцэхгүй байна.");
        }

        newChips = action === "add"
          ? currentChips + amount
          : currentChips - amount;

        if (!Number.isSafeInteger(newChips) || newChips < 0) {
          throw new Error("Чипийн хэмжээ хэтэрсэн байна.");
        }

        transaction.update(targetRef, {
          chips: newChips
        });

        const logRef = db.collection("chipLogs").doc();

        transaction.set(logRef, {
          uid: targetUid,
          amount,
          action,
          adminUid: req.user.uid,
          createdAt: FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        chips: newChips,
        message: "Чипийн үйлдэл амжилттай."
      });

    } catch (error) {
      console.error("ADMIN CHIPS ERROR:", error);

      res.status(400).json({
        message: error.message || "Чип өөрчлөхөд алдаа гарлаа."
      });
    }
  }
);

// ==========================================
// POKER TABLE CONFIGURATION
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

// ==========================================
// TABLE STORAGE
// ==========================================

const tables = new Map();
const socketUsers = new Map();

// Нэвтэрсэн бүх lobby хэрэглэгчийн Socket-ууд.
// Нэг хэрэглэгч олон табаар орсон ч нэг хүнээр тоолно.
const onlineUsers = new Map();

function getOnlineCount() {
  return onlineUsers.size;
}

function registerOnlineUser(socket, user) {
  const uid = user.uid;

  if (!uid) return;

  socket.data.uid = uid;
  socket.data.username = user.username || "";

  let sockets = onlineUsers.get(uid);

  if (!sockets) {
    sockets = new Set();
    onlineUsers.set(uid, sockets);
  }

  sockets.add(socket.id);
  sendLobby();
}

function unregisterOnlineUser(socket) {
  const uid = socket.data.uid;

  if (!uid) return;

  const sockets = onlineUsers.get(uid);

  if (sockets) {
    sockets.delete(socket.id);

    if (sockets.size === 0) {
      onlineUsers.delete(uid);
    }
  }

  socket.data.uid = null;
  sendLobby();
}

function getTable(tableId) {
  if (!tables.has(tableId)) {
    const config = TABLE_CONFIG.find(t => t.id === tableId);

    if (!config) return null;

    tables.set(tableId, {
      ...config,
      players: [],
      communityCards: [],
      deck: [],
      pot: 0,
      currentBet: 0,
      currentPlayerIndex: 0,
      dealerIndex: 0,
      handNumber: 0,
      street: "waiting",
      status: "waiting",
      lastWinner: null,
      lastAction: null
    });
  }

  return tables.get(tableId);
}

// ==========================================
// PUBLIC TABLE DATA
// ==========================================

function getPublicTable(table) {
  if (!table) return null;

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
      seat: index,
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      avatar: player.avatar || "",
      chips: player.chips,
      bet: player.bet,
      folded: player.folded,
      allIn: player.allIn,
      isDealer: index === table.dealerIndex,
      isCurrentTurn:
        table.status === "playing" &&
        index === table.currentPlayerIndex,
      cards:
        player.showCards
          ? player.cards
          : []
    })),
    communityCards: table.communityCards,
    pot: table.pot,
    currentBet: table.currentBet,
    street: table.street,
    status: table.status,
    handNumber: table.handNumber,
    lastWinner: table.lastWinner,
    lastAction: table.lastAction
  };
}

// ==========================================
// TABLE UPDATE
// ==========================================

function sendTableUpdate(table) {
  if (!table) return;

  io.to(`table:${table.id}`).emit(
    "table:update",
    getPublicTable(table)
  );
}

function sendLobby() {
  const lobby = TABLE_CONFIG.map(config => {
    const table = getTable(config.id);

    return {
      id: config.id,
      name: config.name,
      type: config.type,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      minBuyIn: config.minBuyIn,
      maxBuyIn: config.maxBuyIn,
      maxPlayers: config.maxPlayers,
      playersCount: table.players.length,
      status: table.status
    };
  });

  io.emit("lobby:update", {
    tables: lobby,
    onlineCount: getOnlineCount()
  });
}
// ==========================================
// MAKE DECK
// ==========================================

function makeDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = [
    "2", "3", "4", "5", "6", "7",
    "8", "9", "10", "J", "Q", "K", "A"
  ];

  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        suit,
        rank,
        code: rank + suit
      });
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

// ==========================================
// ACTIVE PLAYERS
// ==========================================

function getActivePlayers(table) {
  return table.players.filter(player =>
    !player.folded &&
    !player.disconnected
  );
}

// ==========================================
// NEXT PLAYER
// ==========================================

function nextPlayerIndex(table, currentIndex) {
  if (!table.players.length) return -1;

  for (let step = 1; step <= table.players.length; step++) {
    const index =
      (currentIndex + step) % table.players.length;

    const player = table.players[index];

    if (
      player &&
      !player.folded &&
      !player.disconnected &&
      !player.allIn
    ) {
      return index;
    }
  }

  return -1;
}

// ==========================================
// FINISH HAND
// ==========================================

function finishHand(table, winner) {
  if (!table || table.status !== "playing") return;

  if (winner) {
    winner.chips += table.pot;

    table.lastWinner = {
      uid: winner.uid,
      username: winner.username,
      displayName: winner.displayName,
      amount: table.pot
    };
  }

  table.pot = 0;
  table.currentBet = 0;

  table.players.forEach(player => {
    player.bet = 0;
    player.cards = [];
    player.folded = false;
    player.allIn = false;
    player.showCards = false;
  });

  table.communityCards = [];
  table.deck = [];
  table.street = "waiting";
  table.status = "waiting";
  table.currentPlayerIndex = 0;
  table.lastAction = null;

  sendTableUpdate(table);
  sendLobby();
}

// ==========================================
// START HAND
// ==========================================

function startHand(table) {
  if (!table || table.status === "playing") return false;

  const players = table.players.filter(player =>
    !player.disconnected &&
    player.chips > 0
  );

  if (players.length < 2) return false;

  table.players.forEach(player => {
    player.cards = [];
    player.bet = 0;
    player.folded = false;
    player.allIn = false;
    player.showCards = false;
  });

  table.deck = makeDeck();
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = 0;
  table.lastWinner = null;
  table.lastAction = null;
  table.handNumber++;

  const cardCount = table.type === "omaha" ? 4 : 2;

  players.forEach(player => {
    for (let i = 0; i < cardCount; i++) {
      player.cards.push(table.deck.pop());
    }
  });

  table.dealerIndex =
    (table.dealerIndex + 1) % table.players.length;

  const smallBlindIndex =
    nextPlayerIndex(table, table.dealerIndex);

  const bigBlindIndex =
    smallBlindIndex < 0
      ? -1
      : nextPlayerIndex(table, smallBlindIndex);

  if (smallBlindIndex < 0 || bigBlindIndex < 0) {
    return false;
  }

  const smallBlindPlayer = table.players[smallBlindIndex];
  const bigBlindPlayer = table.players[bigBlindIndex];

  const smallAmount = Math.min(
    smallBlindPlayer.chips,
    table.smallBlind
  );

  const bigAmount = Math.min(
    bigBlindPlayer.chips,
    table.bigBlind
  );

  smallBlindPlayer.chips -= smallAmount;
  smallBlindPlayer.bet = smallAmount;
  table.pot += smallAmount;

  bigBlindPlayer.chips -= bigAmount;
  bigBlindPlayer.bet = bigAmount;
  table.pot += bigAmount;

  smallBlindPlayer.allIn = smallBlindPlayer.chips === 0;
  bigBlindPlayer.allIn = bigBlindPlayer.chips === 0;

  table.currentBet = Math.max(smallAmount, bigAmount);

  table.currentPlayerIndex =
    nextPlayerIndex(table, bigBlindIndex);

  table.street = "preflop";
  table.status = "playing";

  sendTableUpdate(table);
  sendLobby();

  return true;
}

// ==========================================
// ADVANCE STREET
// ==========================================

function advanceStreet(table) {
  if (!table || table.status !== "playing") return;

  const activePlayers = getActivePlayers(table);

  if (activePlayers.length <= 1) {
    finishHand(table, activePlayers[0] || null);
    return;
  }

  table.players.forEach(player => {
    player.bet = 0;
  });

  table.currentBet = 0;

  if (table.street === "preflop") {
    table.communityCards.push(table.deck.pop());
    table.communityCards.push(table.deck.pop());
    table.communityCards.push(table.deck.pop());
    table.street = "flop";

  } else if (table.street === "flop") {
    table.communityCards.push(table.deck.pop());
    table.street = "turn";

  } else if (table.street === "turn") {
    table.communityCards.push(table.deck.pop());
    table.street = "river";

  } else if (table.street === "river") {
    table.lastAction = "Гарын үнэлгээ хүлээгдэж байна.";
    sendTableUpdate(table);
    return;
  }

  table.currentPlayerIndex =
    nextPlayerIndex(table, table.dealerIndex);

  sendTableUpdate(table);
}

// ==========================================
// SOCKET USER
// ==========================================

function getSocketUser(socket) {
  return socketUsers.get(socket.id) || null;
}

// ==========================================
// REFUND PLAYER CHIPS
// ==========================================

function refundPlayerChips(table, player) {
  if (!table || !player) return;

  if (player.bet > 0) {
    player.chips += player.bet;
    table.pot -= player.bet;
    player.bet = 0;
  }
}

// ==========================================
// REMOVE PLAYER FROM TABLE
// ==========================================

function removePlayerFromTable(table, uid) {
  if (!table) return;

  const index = table.players.findIndex(
    player => player.uid === uid
  );

  if (index === -1) return;

  const player = table.players[index];

  if (table.status === "playing") {
    player.disconnected = true;
    player.folded = true;

    if (table.currentPlayerIndex === index) {
      table.currentPlayerIndex =
        nextPlayerIndex(table, index);
    }

    if (getActivePlayers(table).length <= 1) {
      const winner = getActivePlayers(table)[0];
      finishHand(table, winner || null);
    } else {
      sendTableUpdate(table);
    }

    return;
  }

  table.players.splice(index, 1);

  if (table.players.length === 0) {
    table.status = "waiting";
  }

  sendTableUpdate(table);
  sendLobby();
}

// ==========================================
// SOCKET AUTHENTICATION
// ==========================================

io.use(async (socket, next) => {
  try {
    const token = String(
      socket.handshake.auth?.token || ""
    );

    if (!token) {
      return next(new Error("Нэвтрэх шаардлагатай."));
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const userRef = db.collection("users").doc(decoded.uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return next(new Error("Хэрэглэгч олдсонгүй."));
    }

    const user = userSnap.data();

    socket.data.uid = decoded.uid;
    socket.data.username = user.username || "";
    socket.data.displayName =
      user.displayName || user.username || "";

    next();

  } catch (error) {
    console.error("SOCKET AUTH ERROR:", error);
    next(new Error("Нэвтрэх эрх хүчингүй байна."));
  }
});

// ==========================================
// SOCKET CONNECTIONS
// ==========================================

io.on("connection", socket => {
  console.log(
    "Socket connected:",
    socket.id,
    socket.data.username
  );

  // Lobby-д нэвтэрсэн хэрэглэгчийг бүртгэнэ.
  registerOnlineUser(socket, {
    uid: socket.data.uid,
    username: socket.data.username
  });

  // ========================================
  // LOBBY GET
  // ========================================

  socket.on("lobby:get", () => {
    const lobby = TABLE_CONFIG.map(config => {
      const table = getTable(config.id);

      return {
        id: config.id,
        name: config.name,
        type: config.type,
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        minBuyIn: config.minBuyIn,
        maxBuyIn: config.maxBuyIn,
        maxPlayers: config.maxPlayers,
        playersCount: table.players.length,
        status: table.status
      };
    });

    socket.emit("lobby:update", {
      tables: lobby,
      onlineCount: getOnlineCount()
    });
  });

  // ========================================
  // TABLE JOIN
  // ========================================

  socket.on("table:join", async data => {
    try {
      const uid = socket.data.uid;
      const tableId = String(data?.tableId || "");

      if (!uid) {
        socket.emit("error:message", {
          message: "Нэвтрэх шаардлагатай."
        });
        return;
      }

      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        socket.emit("error:message", {
          message: "Хэрэглэгч олдсонгүй."
        });
        return;
      }

      const user = userSnap.data();
      const table = getTable(tableId);

      if (!table) {
        socket.emit("error:message", {
          message: "Ширээ олдсонгүй."
        });
        return;
      }

      const buyIn = Number(data?.buyIn);

      if (
        !Number.isSafeInteger(buyIn) ||
        buyIn < table.minBuyIn ||
        buyIn > table.maxBuyIn
      ) {
        socket.emit("error:message", {
          message: "Ширээний суух чипийн хэмжээ буруу байна."
        });
        return;
      }

      const existingPlayer = table.players.find(
        player => player.uid === uid
      );

      if (existingPlayer) {
        socket.emit("error:message", {
          message: "Та энэ ширээнд аль хэдийн суусан байна."
        });
        return;
      }

      if (table.players.length >= table.maxPlayers) {
        socket.emit("error:message", {
          message: "Ширээ дүүрсэн байна."
        });
        return;
      }

      if (Number(user.chips || 0) < buyIn) {
        socket.emit("error:message", {
          message: "Таны чип хүрэлцэхгүй байна."
        });
        return;
      }

      await userRef.update({
        chips: Number(user.chips || 0) - buyIn
      });

      const player = {
        uid,
        username: user.username || "",
        displayName: user.displayName || user.username || "",
        avatar: user.avatar || "",
        chips: buyIn,
        bet: 0,
        cards: [],
        folded: false,
        allIn: false,
        disconnected: false,
        showCards: false
      };

      table.players.push(player);

      socket.join(`table:${table.id}`);

      socketUsers.set(socket.id, {
        uid,
        tableId: table.id,
        username: player.username
      });

      socket.emit("table:joined", {
        table: getPublicTable(table),
        playerUid: uid
      });

      sendTableUpdate(table);
      sendLobby();

      if (
        table.status !== "playing" &&
        table.players.filter(
          p => !p.disconnected && p.chips > 0
        ).length >= 2
      ) {
        startHand(table);
      }

    } catch (error) {
      console.error("TABLE JOIN ERROR:", error);

      socket.emit("error:message", {
        message: error.message || "Ширээнд суухад алдаа гарлаа."
      });
    }
  });

  // ========================================
  // TABLE LEAVE
  // ========================================

  socket.on("table:leave", async () => {
    try {
      const socketUser = getSocketUser(socket);

      if (!socketUser) return;

      const table = getTable(socketUser.tableId);

      if (!table) return;

      const player = table.players.find(
        p => p.uid === socketUser.uid
      );

      if (player) {
        if (table.status === "playing") {
          player.disconnected = true;
          player.folded = true;

          if (
            table.currentPlayerIndex >= 0 &&
            table.players[table.currentPlayerIndex]?.uid === player.uid
          ) {
            table.currentPlayerIndex =
              nextPlayerIndex(table, table.currentPlayerIndex);
          }

          if (getActivePlayers(table).length <= 1) {
            finishHand(
              table,
              getActivePlayers(table)[0] || null
            );
          } else {
            sendTableUpdate(table);
          }

        } else {
          table.players = table.players.filter(
            p => p.uid !== socketUser.uid
          );

          const userRef = db.collection("users").doc(socketUser.uid);

          await userRef.update({
            chips: FieldValue.increment(player.chips)
          });

          sendTableUpdate(table);
          sendLobby();
        }
      }

      socket.leave(`table:${table.id}`);
      socketUsers.delete(socket.id);

    } catch (error) {
      console.error("TABLE LEAVE ERROR:", error);

      socket.emit("error:message", {
        message: "Ширээнээс гарахад алдаа гарлаа."
      });
    }
  });

  // ========================================
  // GAME ACTION
  // ========================================

  socket.on("game:action", async data => {
    try {
      const socketUser = getSocketUser(socket);

      if (!socketUser) {
        socket.emit("error:message", {
          message: "Ширээнд холбогдоогүй байна."
        });
        return;
      }

      const table = getTable(socketUser.tableId);

      if (!table || table.status !== "playing") return;

      const playerIndex = table.players.findIndex(
        p => p.uid === socketUser.uid
      );

      if (playerIndex === -1) return;

      if (playerIndex !== table.currentPlayerIndex) {
        socket.emit("error:message", {
          message: "Одоо таны ээлж биш байна."
        });
        return;
      }

      const player = table.players[playerIndex];
      const action = String(data?.action || "").toLowerCase();

      if (player.folded || player.allIn) return;

      if (action === "fold") {
        player.folded = true;
        table.lastAction = `${player.displayName} fold`;

      } else if (action === "check") {
        if (player.bet !== table.currentBet) {
          socket.emit("error:message", {
            message: "Check хийх боломжгүй. Call эсвэл Fold хийнэ үү."
          });
          return;
        }

        table.lastAction = `${player.displayName} check`;

      } else if (action === "call") {
        const difference = table.currentBet - player.bet;

        if (difference <= 0) {
          socket.emit("error:message", {
            message: "Call хийх шаардлагагүй."
          });
          return;
        }

        const amount = Math.min(difference, player.chips);

        player.chips -= amount;
        player.bet += amount;
        table.pot += amount;

        if (player.chips === 0) {
          player.allIn = true;
        }

        table.lastAction = `${player.displayName} call ${amount}`;

      } else if (action === "raise") {
        const raiseTo = Number(data?.amount);

        if (
          !Number.isSafeInteger(raiseTo) ||
          raiseTo <= table.currentBet
        ) {
          socket.emit("error:message", {
            message: "Raise-ийн хэмжээ буруу байна."
          });
          return;
        }

        const difference = raiseTo - player.bet;

        if (difference > player.chips) {
          socket.emit("error:message", {
            message: "Таны чип хүрэлцэхгүй байна."
          });
          return;
        }

        player.chips -= difference;
        player.bet += difference;
        table.pot += difference;
        table.currentBet = raiseTo;

        table.lastAction = `${player.displayName} raise ${raiseTo}`;

      } else if (action === "allin") {
        const amount = player.chips;

        if (amount <= 0) return;

        player.chips = 0;
        player.bet += amount;
        table.pot += amount;
        player.allIn = true;

        if (player.bet > table.currentBet) {
          table.currentBet = player.bet;
        }

        table.lastAction = `${player.displayName} all-in`;

      } else {
        socket.emit("error:message", {
          message: "Тоглолтын үйлдэл буруу байна."
        });
        return;
      }

      if (getActivePlayers(table).length <= 1) {
        finishHand(
          table,
          getActivePlayers(table)[0] || null
        );
        return;
      }

      table.currentPlayerIndex =
        nextPlayerIndex(table, playerIndex);

      sendTableUpdate(table);

    } catch (error) {
      console.error("GAME ACTION ERROR:", error);

      socket.emit("error:message", {
        message: "Тоглолтын үйлдэлд алдаа гарлаа."
      });
    }
  });

  // ========================================
  // GAME NEXT
  // ========================================

  socket.on("game:next", () => {
    try {
      const socketUser = getSocketUser(socket);

      if (!socketUser) return;

      const table = getTable(socketUser.tableId);

      if (!table || table.status !== "playing") return;

      const activePlayers = getActivePlayers(table);

      if (activePlayers.length <= 1) {
        finishHand(table, activePlayers[0] || null);
        return;
      }

      advanceStreet(table);

    } catch (error) {
      console.error("GAME NEXT ERROR:", error);

      socket.emit("error:message", {
        message: "Дараагийн үе рүү шилжихэд алдаа гарлаа."
      });
    }
  });

  // ========================================
  // DISCONNECT
  // ========================================

  socket.on("disconnect", () => {
    const socketUser = getSocketUser(socket);

    if (socketUser) {
      const table = getTable(socketUser.tableId);

      if (table) {
        const player = table.players.find(
          p => p.uid === socketUser.uid
        );

        if (player) {
          player.disconnected = true;
          player.folded = true;

          if (
            table.currentPlayerIndex >= 0 &&
            table.players[table.currentPlayerIndex]?.uid === player.uid
          ) {
            table.currentPlayerIndex =
              nextPlayerIndex(table, table.currentPlayerIndex);
          }

          if (getActivePlayers(table).length <= 1) {
            finishHand(
              table,
              getActivePlayers(table)[0] || null
            );
          } else {
            sendTableUpdate(table);
          }
        }
      }

      socketUsers.delete(socket.id);
    }

    unregisterOnlineUser(socket);

    console.log("Socket disconnected:", socket.id);
  });
});

// ==========================================
// ROOT ROUTE
// ==========================================

app.get("/", (req, res) => {
  res.send("BLACKCLUB Poker Server is running.");
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "BLACKCLUB Poker",
    onlineCount: getOnlineCount(),
    time: new Date().toISOString()
  });
});

// ==========================================
// START SERVER
// ==========================================

server.listen(PORT, () => {
  console.log(
    `BLACKCLUB Poker server running on port ${PORT}`
  );
});
