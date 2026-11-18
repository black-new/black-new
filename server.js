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
// Бүртгэл: шинэ хэрэглэгч 0 CHIP-тэй.
app.post("/api/register", async (req, res) => {
  let createdUid = null;

  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const displayName = String(req.body.displayName || username).trim();
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    const bankName = String(req.body.bankName || "").trim().slice(0, 60);
    const bankAccount = String(req.body.bankAccount || "")
      .trim().replace(/\s+/g, "").slice(0, 40);
    const bankHolder = String(req.body.bankHolder || "").trim().slice(0, 80);
    const phone = String(req.body.phone || "").trim().slice(0, 30);

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({
        message: "Хэрэглэгчийн нэр 3-24 тэмдэгт, англи үсэг/тоо/_ байна."
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

    if (password !== confirmPassword) {
      return res.status(400).json({
        message: "Нууц үг баталгаажуулах хэсэгтэй таарахгүй байна."
      });
    }

    if (!bankName || !bankAccount || !bankHolder || !phone) {
      return res.status(400).json({
        message: "Банкны нэр, дансны дугаар, эзэмшигчийн нэр, утсаа бүрэн оруулна уу."
      });
    }

    const account = await firebaseRequest("signUp", {
      email: makeEmail(username),
      password,
      returnSecureToken: true
    });

    createdUid = account.localId;

    const usernameRef = db.collection("usernames").doc(username);
    const userRef = db.collection("users").doc(createdUid);

    await db.runTransaction(async tx => {
      const existing = await tx.get(usernameRef);

      if (existing.exists) {
        throw new Error("Энэ хэрэглэгчийн нэр бүртгэлтэй байна.");
      }

      tx.set(usernameRef, { uid: createdUid });

      tx.set(userRef, {
        uid: createdUid,
        username,
        displayName,
        chips: 0,
        bankName,
        bankAccount,
        bankHolder,
        phone,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    const saved = await userRef.get();

    res.json({
      token: account.idToken,
      user: cleanUser({
        uid: createdUid,
        ...saved.data()
      })
    });

  } catch (e) {
    if (createdUid) {
      try {
        await auth.deleteUser(createdUid);
      } catch (err) {
        console.error("Firebase cleanup:", err);
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
app.post("/api/profile/update", authUser, async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim();
    const bankName = String(req.body.bankName || "").trim().slice(0, 60);
    const bankAccount = String(req.body.bankAccount || "")
      .trim().replace(/\s+/g, "").slice(0, 40);
    const bankHolder = String(req.body.bankHolder || "").trim().slice(0, 80);
    const phone = String(req.body.phone || "").trim().slice(0, 30);

    if (displayName.length < 2 || displayName.length > 18) {
      return res.status(400).json({
        message: "Тоглоомын нэр 2-18 тэмдэгт байна."
      });
    }

    if (!bankName || !bankAccount || !bankHolder || !phone) {
      return res.status(400).json({
        message: "Банкны мэдээлэл болон утасны дугаараа бүрэн оруулна уу."
      });
    }

    await db.collection("users").doc(req.user.uid).set({
      displayName,
      bankName,
      bankAccount,
      bankHolder,
      phone,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const snap = await db.collection("users").doc(req.user.uid).get();

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
function publicRequest(d) {
  return {
    id: d.id,
    uid: d.uid,
    username: d.username,
    displayName: d.displayName,
    type: d.type,
    amount: d.amount,
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
app.post("/api/cashier/deposit", authUser, async (req, res) => {
  try {
    const amount = validAmount(req.body.amount);
    const reference = String(req.body.reference || "").trim().slice(0, 120);

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

    const userSnap = await db.collection("users").doc(req.user.uid).get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: "Хэрэглэгч олдсонгүй." });
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
      message: "Хүсэлт илгээхэд алдаа гарлаа."
    });
  }
});
app.post("/api/cashier/withdraw", authUser, async (req, res) => {
  try {
    const amount = validAmount(req.body.amount);

    if (!amount) {
      return res.status(400).json({
        message: "Дүн 1,000-100,000,000 CHIP байна."
      });
    }

    const userRef = db.collection("users").doc(req.user.uid);
    const reqRef = db.collection("cashierRequests").doc();

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
        throw new Error("Банкны мэдээлэл болон утасны дугаараа профайлд бүрэн оруулна уу.");
      }

      tx.update(userRef, {
        chips: chips - amount,
        updatedAt: FieldValue.serverTimestamp()
      });

      tx.set(reqRef, {
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
      requestId: reqRef.id
    });

  } catch (e) {
    res.status(400).json({
      message: e.message || "Татах хүсэлтэд алдаа гарлаа."
    });
  }
});
