const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// Set these once via:
//   firebase functions:secrets:set PAYSTACK_SECRET_KEY
// (paste your Paystack SECRET key when prompted — the same one your
// app already uses for card payments, NOT the publishable key)
const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");

// ═══════════════════════════════════════════════════════════════
// SHARED HELPERS (ported from the app's client-side VTU engine so
// behaviour matches exactly — server just also holds the API key
// privately now instead of shipping it to every user's browser)
// ═══════════════════════════════════════════════════════════════
const NBS_NET_IDS = {
  MTN: "01", mtn: "01",
  GLO: "02", glo: "02", Glo: "02",
  T2MOBILE: "03", t2mobile: "03", T2Mobile: "03",
  AIRTEL: "04", airtel: "04", Airtel: "04",
  ETISALAT: "04", etisalat: "04", Etisalat: "04", "9mobile": "04", "9MOBILE": "04",
};
const _KOBO_NET_MAP = {
  mtn: "MTN", airtel: "Airtel", glo: "Glo", "9mobile": "Etisalat",
  etisalat: "Etisalat", MTN: "MTN", Airtel: "Airtel", Glo: "Glo",
};
const NBS_DISCO_IDS = {
  ekedc: "01", eko: "01", ikedc: "02", ikeja: "02", aedc: "03", abuja: "03",
  kedco: "04", kano: "04", kedc: "04", phed: "05", phedc: "05", portharcourt: "05",
  jedc: "06", jos: "06", ibedc: "07", ibadan: "07", kaedc: "08", kaduna: "08",
  eedc: "09", enugu: "09", bedc: "10", benin: "10", yedc: "11", yola: "11",
  aple: "12", aba: "12",
};
const NBS_METERTYPE_IDS = { prepaid: "01", postpaid: "02" };
const KYC_TIERS = {
  unverified: { dailyLimit: 0 },
  bronze: { dailyLimit: 50000 },
  silver: { dailyLimit: 200000 },
  gold: { dailyLimit: 1000000 },
};
const KYC_FREE_LIMIT = 20000;
const VTU_TYPES = ["airtime", "data", "electricity", "cabletv"];

function isApiSuccess(res) {
  if (!res) return false;
  const st = String(res.status || res.Status || res.statuscode || res.StatusCode || res.code || "").toLowerCase();
  const sc = String(res.statuscode || res.StatusCode || "").toLowerCase();
  const msg = String(res.message || res.Message || res.description || "").toLowerCase();
  const SUCCESS_CODES = ["100", "200", "00", "0"];
  const SUCCESS_STATUSES = ["order_received", "order_queued", "successful", "success", "completed", "delivered"];
  const FAIL_STATUSES = ["invalid", "missing", "error", "failed", "unauthorized", "insufficient", "unknown"];
  const codeOk = SUCCESS_CODES.some((c) => sc === c);
  const statusOk = SUCCESS_STATUSES.some((s) => st.includes(s));
  const isFail = FAIL_STATUSES.some((f) => st.includes(f) || msg.includes(f));
  return !isFail && (codeOk || statusOk);
}
function getApiError(res) {
  if (!res) return "No response from API provider.";
  return res.message || res.Message || res.description || res.status || JSON.stringify(res).slice(0, 120);
}

async function loadVTUConfig() {
  const snap = await db.collection("settings").doc("apis").get();
  const raw = snap.exists ? snap.data() : {};
  return {
    baseUrl: String(raw.ckURL || raw.baseUrl || "https://www.nellobytesystems.com/").trim().replace(/\/+$/, "") + "/",
    userId: String(raw.ckUser || raw.userId || "").trim(),
    apiKey: String(raw.ckToken || raw.ckKey || raw.apiKey || "").trim(),
    enabled: typeof raw.ckEnabled !== "undefined" ? !!raw.ckEnabled : true,
    endpoints: Object.assign(
      {
        airtime: "APIAirtimeV1.asp",
        data: "APIDatabundleV1.asp",
        cable: "APICableTVV1.asp",
        electricity: "APIElectricityV1.asp",
      },
      raw.ckEndpoints || raw.endpoints || {}
    ),
  };
}
async function loadVTUMargin() {
  try {
    const snap = await db.collection("settings").doc("pricing").get();
    const p = snap.exists ? snap.data() : {};
    return typeof p.vtuMargin === "number" ? p.vtuMargin : 1;
  } catch (e) {
    return 1;
  }
}
async function ckFetch(cfg, endpointKey, params) {
  const endpoint = cfg.endpoints[endpointKey] || endpointKey;
  const url = cfg.baseUrl + endpoint;
  const allParams = { UserID: cfg.userId, APIKey: cfg.apiKey, output: "JSON", ...params };
  const qs = Object.entries(allParams)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const r = await fetch(url + "?" + qs);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { status: "ERROR", message: text.slice(0, 200) };
  }
}
async function executeCKVTU(cfg, d, tid) {
  const nbsNet = _KOBO_NET_MAP[d.provider || "mtn"] || "MTN";
  const netId = NBS_NET_IDS[nbsNet] || NBS_NET_IDS[String(nbsNet).toUpperCase()] || nbsNet;
  let apiResult = null;

  if (d.type === "airtime") {
    apiResult = await ckFetch(cfg, "airtime", {
      MobileNumber: d.phone, MobileNetwork: netId, Amount: d.amount, RequestID: tid,
    });
  } else if (d.type === "data") {
    apiResult = await ckFetch(cfg, "data", {
      MobileNumber: d.phone, MobileNetwork: netId, DataPlan: String(d.planCode || "").trim(),
      Amount: d.amount, RequestID: tid,
    });
  } else if (d.type === "cabletv") {
    const provKey = (d.provider || "dstv").toLowerCase().replace(/\s/g, "");
    const validProviders = ["dstv", "gotv", "startimes", "showmax"];
    const provId = validProviders.includes(provKey) ? provKey : "dstv";
    apiResult = await ckFetch(cfg, "cable", {
      CableTV: provId, Package: d.planCode || "", SmartCardNo: d.cardNo || "",
      PhoneNo: d.phone || "", RequestID: tid,
    });
  } else if (d.type === "electricity") {
    const discoId = NBS_DISCO_IDS[String(d.provider).toLowerCase()] || d.provider;
    const meterTypeId = NBS_METERTYPE_IDS[String(d.meterType || "prepaid").toLowerCase()] || d.meterType;
    apiResult = await ckFetch(cfg, "electricity", {
      ElectricCompany: discoId, MeterType: meterTypeId, MeterNo: d.meter || "",
      Amount: d.amount, PhoneNo: d.phone || "", RequestID: tid,
    });
  }

  const success = isApiSuccess(apiResult);
  return { success, message: success ? "Processed" : getApiError(apiResult), data: apiResult };
}

// ═══════════════════════════════════════════════════════════════
// purchaseVTU — callable from the app. Verifies PIN + KYC limits,
// debits the wallet, calls ClubKonnect using the API key (which now
// lives ONLY here on the server, never sent to the browser), and
// refunds automatically if the provider declines. Mirrors the exact
// logic that used to run client-side in confirmTx()/executeCKVTU().
// ═══════════════════════════════════════════════════════════════
exports.purchaseVTU = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in again.");
  const uid = request.auth.uid;
  const d = request.data || {};
  const pin = String(d.pin || "");

  if (!VTU_TYPES.includes(d.type)) {
    throw new HttpsError("invalid-argument", "Unsupported transaction type.");
  }
  const amount = Number(d.amount);
  if (!amount || amount <= 0) throw new HttpsError("invalid-argument", "Invalid amount.");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("not-found", "User account not found.");
  const ud = userSnap.data();

  // ── PIN check (server-side — the PIN itself never left Firestore to be compared) ──
  if (!ud.transactionPIN) {
    throw new HttpsError("failed-precondition", "Please set your transaction PIN first.");
  }
  if (String(ud.transactionPIN) !== pin) {
    throw new HttpsError("permission-denied", "Incorrect PIN.");
  }

  // ── KYC / daily-limit check (mirrors checkTransactionLimit in the app) ──
  const kycTier = ud.kycTier || "unverified";
  const kycStatus = ud.kycStatus || "unverified";
  const isVerified = kycStatus === "approved" && kycTier !== "unverified";
  if (amount >= KYC_FREE_LIMIT) {
    if (!isVerified) {
      throw new HttpsError("failed-precondition", `Transactions of ₦${amount.toLocaleString()} require KYC verification. Please complete KYC first.`);
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const txSnap = await db.collection("transactions").where("userId", "==", uid).where("status", "==", "success").get();
    let todaySpent = 0;
    txSnap.forEach((docu) => {
      const tx = docu.data();
      const txDate = tx.createdAt && tx.createdAt.toDate ? tx.createdAt.toDate() : new Date(tx.createdAt);
      if (txDate >= todayStart && !["fund", "fund_approved", "referral_bonus", "admin_credit"].includes(tx.type)) {
        todaySpent += tx.amount || 0;
      }
    });
    const dailyLimit = (KYC_TIERS[kycTier] || KYC_TIERS.unverified).dailyLimit;
    if (todaySpent + amount > dailyLimit) {
      throw new HttpsError("resource-exhausted", `Daily limit of ₦${dailyLimit.toLocaleString()} reached. Remaining: ₦${Math.max(0, dailyLimit - todaySpent).toLocaleString()}.`);
    }
  }

  if ((ud.balance || 0) < amount) {
    throw new HttpsError("failed-precondition", "Insufficient balance.");
  }

  const cfg = await loadVTUConfig();
  if (!cfg.enabled) throw new HttpsError("unavailable", "VTU is currently disabled by admin.");
  if (!cfg.apiKey) throw new HttpsError("failed-precondition", "API Key not configured. Contact admin.");

  const vtuMarginPct = await loadVTUMargin();
  const fee = Math.round(amount * (vtuMarginPct / 100) * 100) / 100;
  const tid = db.collection("transactions").doc().id;

  // 1. Debit wallet + write a "processing" transaction record atomically
  let balanceBefore = 0;
  await db.runTransaction(async (t) => {
    const fresh = await t.get(userRef);
    const bal = fresh.data().balance || 0;
    balanceBefore = bal;
    if (bal < amount) throw new HttpsError("failed-precondition", "Insufficient balance.");
    t.update(userRef, {
      balance: admin.firestore.FieldValue.increment(-amount),
      totalSpent: admin.firestore.FieldValue.increment(amount),
    });
    t.set(db.collection("transactions").doc(tid), {
      id: tid, userId: uid, type: d.type, status: "processing",
      amount, fee, description: d.description || d.type,
      provider: cfg.providerName || "Nellobytesystems",
      phone: d.phone || "", meter: d.meter || "", cardNo: d.cardNo || "",
      balanceBefore: bal, balanceAfter: bal - amount,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  // 2. Call the VTU provider
  let ckResult = null;
  let txStatus = "success";
  let txNote = "";
  try {
    ckResult = await executeCKVTU(cfg, d, tid);
    if (!ckResult.success) {
      txStatus = "failed";
      txNote = ckResult.message || "Transaction declined by provider.";
    }
  } catch (err) {
    txStatus = "failed";
    txNote = "Could not reach VTU provider. Please try again.";
  }

  // 3. Refund automatically on failure, finalize transaction record
  if (txStatus === "failed") {
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(amount),
      totalSpent: admin.firestore.FieldValue.increment(-amount),
    });
  }
  await db.collection("transactions").doc(tid).update({
    status: txStatus,
    note: txNote,
    ckResponse: ckResult && ckResult.data ? JSON.stringify(ckResult.data).substring(0, 500) : "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (txStatus === "failed") {
    throw new HttpsError("aborted", txNote || "Transaction failed. Your wallet has been refunded.");
  }

  await db.collection("notifications").add({
    userId: uid,
    title: "✅ Purchase Successful",
    message: `₦${amount.toLocaleString()} ${d.type} purchase was successful.`,
    type: "success", read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, transactionId: tid, balanceAfter: balanceBefore - amount };
});

// ═══════════════════════════════════════════════════════════════
// verifyPaystackPayment — callable from the app after the Paystack
// Pop popup reports success. The client no longer credits the wallet
// itself; this function independently re-checks the payment with
// Paystack's servers (using the secret key, held only here) before
// crediting anything — so a manipulated client callback can no
// longer fake a successful payment.
// ═══════════════════════════════════════════════════════════════
exports.verifyPaystackPayment = onCall(
  { secrets: [PAYSTACK_SECRET_KEY], region: "us-central1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in again.");
    const uid = request.auth.uid;
    const reference = request.data && request.data.reference;
    if (!reference) throw new HttpsError("invalid-argument", "Missing payment reference.");

    // Idempotency: never credit the same Paystack reference twice
    const txDocId = "paystack_" + reference;
    const txRef = db.collection("transactions").doc(txDocId);
    const existing = await txRef.get();
    if (existing.exists) {
      return { success: true, alreadyProcessed: true, amount: existing.data().amount };
    }

    const secret = PAYSTACK_SECRET_KEY.value();
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: "Bearer " + secret },
    });
    const j = await r.json();

    if (!j.status || !j.data || j.data.status !== "success") {
      throw new HttpsError("failed-precondition", "Payment could not be verified as successful.");
    }
    if (j.data.currency !== "NGN") {
      throw new HttpsError("failed-precondition", "Unexpected currency on payment.");
    }

    // Authoritative amount comes from Paystack's own record, never the client
    const amount = j.data.amount / 100;

    const userRef = db.collection("users").doc(uid);
    await db.runTransaction(async (t) => {
      const fresh = await t.get(txRef);
      if (fresh.exists) return; // race guard
      t.set(txRef, {
        id: txDocId, userId: uid, type: "fund_approved", status: "success",
        amount, description: "Wallet Funded via Paystack", reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      t.update(userRef, {
        balance: admin.firestore.FieldValue.increment(amount),
        totalFunded: admin.firestore.FieldValue.increment(amount),
      });
    });

    await db.collection("notifications").add({
      userId: uid,
      title: "✅ Wallet Funded!",
      message: `₦${amount.toLocaleString()} via Paystack`,
      type: "success", read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, amount };
  }
);

exports.paystackWebhook = onRequest(
  { secrets: [PAYSTACK_SECRET_KEY], region: "us-central1", cors: false },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method not allowed");
      }

      const secret = PAYSTACK_SECRET_KEY.value();

      // ── 1. Verify this request genuinely came from Paystack ──
      // req.rawBody is provided automatically by Cloud Functions for
      // signature verification (must hash the raw bytes, not the parsed JSON).
      const signature = req.headers["x-paystack-signature"];
      const hash = crypto
        .createHmac("sha512", secret)
        .update(req.rawBody)
        .digest("hex");

      if (!signature || hash !== signature) {
        console.warn("Paystack webhook: invalid signature — request ignored");
        return res.status(401).send("Invalid signature");
      }

      const event = req.body;

      // ── 2. Only handle successful dedicated-account bank transfers ──
      if (event.event !== "charge.success") {
        return res.status(200).send("Ignored: not a charge.success event");
      }
      const data = event.data;
      if (data.channel !== "dedicated_nuban") {
        return res.status(200).send("Ignored: not a dedicated account transfer");
      }

      const customerCode = data.customer && data.customer.customer_code;
      const amount = data.amount / 100; // Paystack sends amount in kobo
      const reference = data.reference;
      const paystackTxId = data.id;

      if (!customerCode) {
        console.warn("Paystack webhook: no customer_code on event", paystackTxId);
        return res.status(200).send("No customer code on event");
      }

      // ── 3. Idempotency guard ──
      // Uses the same doc-id scheme as the app's manual "Check Now" button
      // (dva_<paystackTransactionId>) so a payment is never credited twice,
      // no matter which path (webhook or manual check) processes it first.
      const txDocId = `dva_${paystackTxId}`;
      const txRef = db.collection("transactions").doc(txDocId);
      const txSnap = await txRef.get();
      if (txSnap.exists) {
        return res.status(200).send("Already processed");
      }

      // ── 4. Find the KOBOrush user this dedicated account belongs to ──
      const usersSnap = await db
        .collection("users")
        .where("dvaCustomerCode", "==", customerCode)
        .limit(1)
        .get();

      if (usersSnap.empty) {
        console.error("Paystack webhook: no user found for customer code", customerCode);
        return res.status(200).send("No matching user for this customer code");
      }

      const userDoc = usersSnap.docs[0];
      const userId = userDoc.id;
      const userRef = db.collection("users").doc(userId);

      // ── 5. Credit the wallet + log the transaction atomically ──
      await db.runTransaction(async (t) => {
        const freshTx = await t.get(txRef);
        if (freshTx.exists) return; // guard against a race with a second webhook retry
        t.set(txRef, {
          id: txDocId,
          userId,
          type: "fund_approved",
          status: "success",
          amount,
          description: "Wallet Funded via Bank Transfer (Dedicated Account)",
          reference,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        t.update(userRef, {
          balance: admin.firestore.FieldValue.increment(amount),
          totalFunded: admin.firestore.FieldValue.increment(amount),
        });
      });

      // ── 6. Notify the user (matches the app's existing notifications schema) ──
      await db.collection("notifications").add({
        userId,
        title: "✅ Wallet Funded!",
        message: `₦${amount.toLocaleString()} was added to your wallet via bank transfer.`,
        type: "success",
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Credited ₦${amount} to user ${userId} (tx ${txDocId})`);
      return res.status(200).send("OK");
    } catch (err) {
      console.error("Paystack webhook error:", err);
      // Return 500 so Paystack retries the webhook later
      return res.status(500).send("Server error");
    }
  }
);
