const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const https = require("https");
const Razorpay = require("razorpay");
const fetch = require("node-fetch");
const rateLimit = require("express-rate-limit");
const { NodeSSH } = require("node-ssh");

dotenv.config();

const { Cashfree, CFEnvironment } = require("cashfree-pg");
let cashfreeClient = new Cashfree(
  process.env.CASHFREE_ENV === "production" ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX,
  process.env.CASHFREE_CLIENT_ID,
  process.env.CASHFREE_CLIENT_SECRET
);
const ACTIVE_GATEWAY = (process.env.PAYMENT_GATEWAY || "razorpay").toLowerCase();
// ==================== HOSTHEAVEN CONFIG ====================
const HOSTHEAVEN_BASE = "https://vps.hostheaven.in";
const HOSTHEAVEN_EMAIL = process.env.HOSTHEAVEN_EMAIL;
const HOSTHEAVEN_PASSWORD = process.env.HOSTHEAVEN_PASSWORD;
const RESELLER_DOMAIN = process.env.HOSTHEAVEN_RESELLER_DOMAIN;

let hostHeavenToken = null;
let hostHeavenUserId = null;
let tokenRefreshing = false;
let tokenRefreshPromise = null;

const hhRequestQueue = [];
let hhRequestRunning = false;

async function processHHQueue() {
  if (hhRequestRunning || hhRequestQueue.length === 0) return;
  hhRequestRunning = true;
  const { endpoint, method, body, resolve, reject } = hhRequestQueue.shift();
  try {
    resolve(await hostHeavenAPIDirect(endpoint, method, body));
  } catch (err) {
    reject(err);
  } finally {
    hhRequestRunning = false;
    setTimeout(processHHQueue, 500);
  }
}

async function hostHeavenAPIDirect(endpoint, method = "GET", body = null) {
  if (!hostHeavenToken) await getHostHeavenToken();
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${hostHeavenToken}`,
    "X-Reseller-Domain": RESELLER_DOMAIN,
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${HOSTHEAVEN_BASE}${endpoint}`, opts);
  if (res.status === 401 || res.status === 403) {
    hostHeavenToken = null;
    await getHostHeavenToken();
    const headers2 = { ...headers, Authorization: `Bearer ${hostHeavenToken}` };
    const opts2 = { method, headers: headers2 };
    if (body) opts2.body = JSON.stringify(body);
    return (await fetch(`${HOSTHEAVEN_BASE}${endpoint}`, opts2)).json();
  }
  return res.json();
}

function hostHeavenAPI(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    hhRequestQueue.push({ endpoint, method, body, resolve, reject });
    processHHQueue();
  });
}

async function getHostHeavenToken() {
  if (hostHeavenToken) return hostHeavenToken;
  if (tokenRefreshing) return tokenRefreshPromise;
  tokenRefreshing = true;
  tokenRefreshPromise = (async () => {
    try {
      const res = await fetch(`${HOSTHEAVEN_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Reseller-Domain": RESELLER_DOMAIN },
        body: JSON.stringify({ email: HOSTHEAVEN_EMAIL, password: HOSTHEAVEN_PASSWORD }),
      });
      const data = await res.json();
      hostHeavenToken = data.token;
      try {
        const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64").toString());
        hostHeavenUserId = payload.userId || payload.id || payload.sub;
      } catch (e) {}
      setTimeout(() => { hostHeavenToken = null; }, 50 * 60 * 1000);
      return hostHeavenToken;
    } finally {
      tokenRefreshing = false;
    }
  })();
  return tokenRefreshPromise;
}

let vmOverviewCache = null;
let vmOverviewCacheTime = 0;
async function getVmOverviewCached() {
  const now = Date.now();
  if (vmOverviewCache && now - vmOverviewCacheTime < 20000) return vmOverviewCache;
  const data = await hostHeavenAPI("/api/users/orders/overview?page=0&size=10000");
  vmOverviewCache = data;
  vmOverviewCacheTime = now;
  return data;
}
// ==================== END HOSTHEAVEN CONFIG ====================

const app = express();

const allowedOrigins = [
  "https://serverbazar.com",
  "https://www.serverbazar.com",
  "https://serverbazar.web.app",
  "https://serverbazar.firebaseapp.com"
];

app.use(cors({
  origin: function (origin, callback) {
    // Postman jaise tools origin nahi bhejte — unhe allow ya block karna tumhari marzi
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS blocked: is domain se access nahi hai."));
  },
  credentials: true,
}));

app.use(express.json());
// Login/Register ke liye limiter — 15 min me max 10 tries per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Bahut zyada attempts ho gaye. 15 minute baad try karo." },
});

// Coupon check karne ke liye limiter — thoda loose, kyunki genuine user retry karega
const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: "Bahut zyada coupon attempts. Thodi der baad try karo." },
});
const proxyConnectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Bahut zyada connect attempts. 15 minute baad try karo." },
});

// ==================== RAZORPAY INSTANCE ====================
// .env me RAZORPAY_KEY_ID aur RAZORPAY_KEY_SECRET set karo (secret sirf backend me, KABHI frontend me nahi)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ==================== DATABASE CONNECT ====================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected successfully ✅");
    await seedAdmin();
  } catch (err) {
    console.error("MongoDB connection error ❌", err.message);
    process.exit(1);
  }
};

// ==================== ADMIN AUTO-SEED ====================
async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) return;

  try {
    let admin = await User.findOne({ email: adminEmail.toLowerCase() });

    if (!admin) {
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      admin = await User.create({
        name: "Admin",
        email: adminEmail.toLowerCase(),
        password: hashedPassword,
        role: "admin",
      });
      console.log(`Admin account auto-created ✅ (${adminEmail})`);
    } else if (admin.role !== "admin") {
      admin.role = "admin";
      await admin.save();
      console.log(`Existing user promoted to admin ✅ (${adminEmail})`);
    }
  } catch (err) {
    console.error("Admin seed error:", err.message);
  }
}

// ==================== TELEGRAM ORDER ALERTS ====================
// .env me daalo:
//   TELEGRAM_BOT_TOKEN=              (BotFather se milega)
//   TELEGRAM_ADMIN_CHAT_ID=id1,id2   (ek ya zyada admin chat ids, comma se separate)
// Dono set na ho to alert silently skip ho jaata hai — baaki app normally chalta rahega.

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
// ==================== PROXY ENCRYPT/DECRYPT HELPERS ====================
function encryptSecret(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decryptSecret(payload) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// ==================== USER-SERVER PROXY SETUP (Squid) ====================

// Server par SSH se login karke uska OS pata karta hai (install se pehle)
async function detectServerOS({ ip, username, password }) {
  const ssh = new NodeSSH();
  await ssh.connect({ host: ip, username, password, readyTimeout: 30000 });
  const result = await ssh.execCommand(
    "cat /etc/os-release | grep ^ID= | cut -d'=' -f2 | tr -d '\"'"
  );
  ssh.dispose();
  return { os: (result.stdout || "unknown").trim() || "unknown" };
}

// Ab ye function proxy username/password KHUD generate nahi karta —
// bahar se (user ke chune hue ya random generate hue) le leta hai
async function setupProxyOnServer({ ip, username, password, proxyUsername, proxyPassword, forceReinstall }) {
  const ssh = new NodeSSH();
  await ssh.connect({ host: ip, username, password, readyTimeout: 30000 });

  if (forceReinstall) {
    await ssh.execCommand("command -v squid-uninstall >/dev/null 2>&1 && squid-uninstall || true");
  }

  const installResult = await ssh.execCommand(
    "wget -q https://raw.githubusercontent.com/serverok/squid-proxy-installer/master/squid3-install.sh -O /root/squid3-install.sh && bash /root/squid3-install.sh"
  );

  const outputText = (installResult.stdout || "") + (installResult.stderr || "");
  if (/already installed/i.test(outputText)) {
    ssh.dispose();
    const err = new Error("Squid pehle se installed hai is server par.");
    err.alreadyInstalled = true;
    throw err;
  }

  if (installResult.code !== 0) {
    ssh.dispose();
    throw new Error(
      `Squid install fail hua (exit code: ${installResult.code}):\nSTDOUT: ${installResult.stdout || "(khaali)"}\nSTDERR: ${installResult.stderr || "(khaali)"}`
    );
  }

  const userResult = await ssh.execCommand(
    `htpasswd -b -c /etc/squid/passwd ${proxyUsername} ${proxyPassword}`
  );
  if (userResult.code !== 0) {
    ssh.dispose();
    throw new Error(`User add nahi ho paya:\n${userResult.stderr}`);
  }

  await ssh.execCommand("systemctl reload squid");
  ssh.dispose();

  return { proxyIp: ip, proxyPort: 3128, proxyUsername, proxyPassword };
}

// Ek chat id ko ek message bhejta hai (single request)
function sendTelegramMessageToChat(token, chatId, text) {
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${token}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode >= 400) {
        console.error(`Telegram alert failed (chat ${chatId}):`, res.statusCode, data);
      }
    });
  });

  req.on("error", (err) => console.error(`Telegram alert error (chat ${chatId}):`, err.message));
  req.write(payload);
  req.end();
}

// Saare admins ko ek saath bhejta hai — TELEGRAM_ADMIN_CHAT_ID me jitne bhi
// comma-separated chat ids hon, sabko same message chala jaata hai.
function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rawChatIds = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !rawChatIds) {
    console.warn("Telegram alert skipped: TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID set nahi hai.");
    return;
  }

  const chatIds = rawChatIds
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  chatIds.forEach((chatId) => sendTelegramMessageToChat(token, chatId, text));
}

// Naya order confirm hote hi admin ko bhejne wala message banata hai
function buildOrderAlertMessage({ user, order }) {
  const categoryLabel = order.category === "linux" ? "🐧 Linux IP" : "🖥️ VPS";

  const lines = [
    `🛒 <b>Naya Order Mila!</b>`,
    ``,
    `${categoryLabel} <b>Order</b>`,
    `👤 <b>Naam:</b> ${escapeHtml(user?.name)}`,
    `📧 <b>Email:</b> ${escapeHtml(user?.email)}`,
    `🌐 <b>Plan / IP:</b> ${escapeHtml(order.nameOrIp || order.planName)}`,
    `💾 <b>RAM:</b> ${escapeHtml(order.ram || "-")}`,
    `💰 <b>Price:</b> ₹${order.price}`,
  ];

  if (order.couponCode) {
    lines.push(`🏷️ <b>Coupon:</b> ${escapeHtml(order.couponCode)} (−₹${order.discountAmount})`);
  } else {
    lines.push(`🏷️ <b>Coupon:</b> Koi nahi`);
  }

  lines.push(`✅ <b>Final Paid:</b> ₹${order.finalAmount}`);
  lines.push(``);
  const gatewayLabel = order.paymentGateway === "cashfree" ? "Cashfree" : "Razorpay";
  const paymentId = order.paymentGateway === "cashfree" ? order.cfPaymentId : order.razorpayPaymentId;
  lines.push(`💳 <b>Gateway:</b> ${gatewayLabel}`);
  lines.push(`🧾 <b>Payment ID:</b> <code>${escapeHtml(paymentId || "-")}</code>`);
  lines.push(`🆔 <b>Order ID:</b> <code>${escapeHtml(order._id)}</code>`);

  return lines.join("\n");
}

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    phone: { type: String },
    role: { type: String, default: "user" },
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    planName: { type: String, required: true },
    category: { type: String, enum: ["vps", "linux"], default: "vps" }, // vps ya linux
    vpsId: { type: String },
    nameOrIp: { type: String }, // plan ka listed IP/name jo user ne khareeda
    ram: { type: String },
    price: { type: Number, required: true }, // original plan price (before discount)
    // ---- coupon info ----
    couponCode: { type: String },
    discountAmount: { type: Number, default: 0 },
    finalAmount: { type: Number }, // price - discountAmount (jo actually charge hua)
    status: { type: String, default: "pending" }, // pending | active | delivered | cancelled
    // ---- payment info ----
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    cfOrderId: { type: String },
cfPaymentId: { type: String },
paymentGateway: { type: String, enum: ["razorpay", "cashfree", "wallet"], default: "razorpay" },
    paymentStatus: { type: String, default: "paid" }, // order sirf tabhi banta hai jab payment verify ho jaye
    // ---- delivery details (admin fill karega jab VPS actually deliver kare) ----
    deliveryIp: { type: String },
    deliveryUsername: { type: String },
    deliveryPassword: { type: String },
    deliveryOS: { type: String },
    deliveredAt: { type: Date },
    validityDays: { type: Number, default: 30 }, // kitne din ka plan hai
    expiresAt: { type: Date }, // deliveredAt + validityDays se calculate hota hai
    // ---- Format/Reinstall request tracking ----
    formatStatus: { type: String, enum: ["none", "pending"], default: "none" },
    formatRequestedAt: { type: Date },
    lastFormattedAt: { type: Date },
    formatReason: { type: String },
formatSolution: { type: String },
formatSeenByUser: { type: Boolean, default: true },
vmId: { type: Number, default: null },
  },
  { timestamps: true }
);
const Order = mongoose.model("Order", orderSchema);

const vpsPlanSchema = new mongoose.Schema(
  {
    vpsId: { type: String, required: true, unique: true },
    nameOrIp: { type: String, required: true },
    label: { type: String },
    company: { type: String, default: "Manual Delivery" },
    ramOptions: [
      {
        ram: { type: String, required: true },
        price: { type: Number, required: true },
      },
    ],
    available: { type: Boolean, default: true },
    bestSeller: { type: Boolean, default: false }, // admin manually marks this as "Most Demanded"
    category: { type: String, enum: ["vps", "linux"], default: "vps" }, // "vps" ya "linux"
  },
  { timestamps: true }
);
const VpsPlan = mongoose.model("VpsPlan", vpsPlanSchema);

// ---- Coupon codes (admin banata hai) ----
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    discountType: { type: String, enum: ["flat", "percent"], required: true }, // flat = ₹ off, percent = % off
    discountValue: { type: Number, required: true }, // flat: amount, percent: 1-100
    maxDiscountAmount: { type: Number }, // percent type ke liye upper cap (optional)
    minOrderAmount: { type: Number, default: 0 }, // is amount se kam order pe coupon nahi chalega
    usageLimit: { type: Number }, // total kitni baar use ho sakta hai (null = unlimited)
    usedCount: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 }, // ek user kitni baar use kar sakta hai
    expiresAt: { type: Date }, // null = kabhi expire nahi hoga
    active: { type: Boolean, default: true },
    category: { type: String, enum: ["vps", "linux", "both"], default: "both" },
    assignedToEmail: { type: String, lowercase: true, trim: true, default: null },
  },
  { timestamps: true }
);
const Coupon = mongoose.model("Coupon", couponSchema);

// ---- Payment abhi pending hai, ye temporary record hai jab tak Razorpay confirm na kare ----
// 15 min me khud expire ho jayega agar user payment complete nahi karta (TTL index)
const pendingPaymentSchema = new mongoose.Schema(
  {
    razorpayOrderId: { type: String, unique: true, sparse: true },
cfOrderId: { type: String, unique: true, sparse: true },
paymentGateway: { type: String, enum: ["razorpay", "cashfree", "wallet"], default: "razorpay" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    vpsId: { type: String, required: true },
    nameOrIp: { type: String },
    planName: { type: String, required: true },
    category: { type: String, enum: ["vps", "linux"], default: "vps" },
    ram: { type: String, required: true },
    price: { type: Number, required: true }, // original price
    couponCode: { type: String },
    discountAmount: { type: Number, default: 0 },
    finalAmount: { type: Number, required: true }, // jo actually charge hua (Razorpay amount)
    createdAt: { type: Date, default: Date.now, expires: 900 }, // 900s = 15 min TTL
  }
);
const PendingPayment = mongoose.model("PendingPayment", pendingPaymentSchema);
// ==================== NOTICE SCHEMA ====================
const noticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    message: { type: String, required: true },
    category: { type: String, enum: ["vps", "linux", "all"], default: "all" },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);
const Notice = mongoose.model("Notice", noticeSchema);
noticeSchema.index({ active: 1, category: 1, createdAt: -1 });

// ==================== WALLET SCHEMAS ====================
const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);
const Wallet = mongoose.model("Wallet", walletSchema);

const walletTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["credit", "debit", "refund"], required: true },
    amount: { type: Number, required: true },
    description: { type: String, default: "" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" }, // agar wallet se VPS khareeda
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // ✅ NAYA
    status: { type: String, enum: ["pending", "completed", "failed"], default: "completed" },
  },
  { timestamps: true }
);
const WalletTransaction = mongoose.model("WalletTransaction", walletTransactionSchema);
walletTransactionSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
const proxyServerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    ip: { type: String, required: true, trim: true },
    sshUsername: { type: String, required: true, trim: true },
    sshPasswordEncrypted: { type: String, required: true },
    proxyPort: { type: Number },
    proxyUsername: { type: String },
    proxyPasswordEncrypted: { type: String },
    status: { type: String, enum: ["connecting", "active", "failed"], default: "connecting" },
    lastError: { type: String },
  },
  { timestamps: true }
);
const ProxyServer = mongoose.model("ProxyServer", proxyServerSchema);

// ==================== MIDDLEWARE (auth check) ====================
const protect = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Login required. Token nahi mila." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token invalid ya expire ho gaya." });
  }
};

// ==================== MIDDLEWARE (admin check) ====================
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Sirf admin ke liye access hai." });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ==================== SECRET (.env) COUPONS ====================
// Ye coupons DATABASE me kabhi save nahi hote — sirf .env se load hote hain.
// Isliye ye admin panel ya /api/admin/coupons se kabhi dikhega nahi, na koi DB
// dekh ke inko dhoond sakta hai. Jitne chaho utne SECRET_COUPON_<n>_CODE /
// SECRET_COUPON_<n>_DISCOUNT pairs .env me daal do (n = 1, 2, 3...).
function loadSecretCoupons() {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const code = process.env[`SECRET_COUPON_${i}_CODE`];
    const discount = process.env[`SECRET_COUPON_${i}_DISCOUNT`];
    if (code && discount) {
      list.push({ code: code.trim().toUpperCase(), discountValue: Number(discount) });
    }
  }
  return list;
}
const SECRET_COUPONS = loadSecretCoupons();
const SECRET_COUPON_PER_USER_LIMIT = 1; // har user isko sirf 1 baar use kar sakta hai

// ==================== COUPON HELPER ====================
// Ek coupon code, plan price aur user ke against valid hai ya nahi check karta hai.
// Ye function backend ke andar hi use hota hai (create-payment aur validate dono jagah)
// taaki logic ek hi jagah rahe aur dono kabhi out-of-sync na ho.
async function checkCouponValidity(code, price, userId, category, userEmail) {
  if (!code) {
    return { valid: false, message: "Coupon code do." };
  }

  const normalizedCode = code.trim().toUpperCase();

  // ---- Pehle .env wale secret coupons check karo (DB me nahi hain) ----
  const secretMatch = SECRET_COUPONS.find((c) => c.code === normalizedCode);
  if (secretMatch) {
    if (price < secretMatch.discountValue + 1) {
      return { valid: false, message: "Ye coupon is order par apply nahi hoga." };
    }

    const timesUsedByUser = await Order.countDocuments({
      user: userId,
      couponCode: secretMatch.code,
    });
    if (timesUsedByUser >= SECRET_COUPON_PER_USER_LIMIT) {
      return { valid: false, message: "Aap ye coupon pehle hi use kar chuke ho." };
    }

    const discountAmount = Math.min(secretMatch.discountValue, price - 1);
    const finalAmount = price - discountAmount;

    return {
      valid: true,
      coupon: { code: secretMatch.code },
      discountAmount,
      finalAmount,
      message: "Coupon apply ho gaya!",
    };
  }

  // ---- Warna normal DB wale coupons me dhoondo ----
  const coupon = await Coupon.findOne({ code: normalizedCode });

  if (!coupon || !coupon.active) {
    return { valid: false, message: "Ye coupon code valid nahi hai." };
  }
  if (coupon.category && coupon.category !== "both" && coupon.category !== category) {
    return { valid: false, message: "Ye coupon is category ke liye valid nahi hai." };
  }

  if (coupon.assignedToEmail) {
    if (!userEmail || coupon.assignedToEmail !== userEmail.toLowerCase().trim()) {
      return { valid: false, message: "Ye coupon code valid nahi hai." };
    }
  }

  if (coupon.expiresAt && new Date() > coupon.expiresAt) {
    return { valid: false, message: "Ye coupon expire ho chuka hai." };
  }

  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, message: "Is coupon ki usage limit khatam ho gayi hai." };
  }

  if (price < coupon.minOrderAmount) {
    return {
      valid: false,
      message: `Ye coupon sirf ₹${coupon.minOrderAmount} ya usse zyada ke order par chalega.`,
    };
  }

  if (coupon.perUserLimit != null) {
    const timesUsedByUser = await Order.countDocuments({
      user: userId,
      couponCode: coupon.code,
    });
    if (timesUsedByUser >= coupon.perUserLimit) {
      return { valid: false, message: "Aap ye coupon pehle hi use kar chuke ho." };
    }
  }

  // ---- discount calculate karo ----
  let discountAmount = 0;
  if (coupon.discountType === "flat") {
    discountAmount = coupon.discountValue;
  } else {
    discountAmount = (price * coupon.discountValue) / 100;
    if (coupon.maxDiscountAmount != null) {
      discountAmount = Math.min(discountAmount, coupon.maxDiscountAmount);
    }
  }

  // discount price se zyada nahi ho sakta, aur final price kam se kam ₹1 rahegi
  discountAmount = Math.min(discountAmount, price - 1);
  discountAmount = Math.max(0, Math.round(discountAmount));

  const finalAmount = price - discountAmount;

  return {
    valid: true,
    coupon,
    discountAmount,
    finalAmount,
    message: "Coupon apply ho gaya!",
  };
}

// ==================== AUTH ROUTES ====================

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Sab fields bharo." });
    }
    // ✅ YE LINE ADD KARO
    if (typeof email !== "string" || typeof password !== "string" || typeof name !== "string") {
      return res.status(400).json({ message: "Invalid input format." });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Ye email pehle se register hai." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const role = email.toLowerCase() === (process.env.ADMIN_EMAIL || "").toLowerCase()
      ? "admin"
      : "user";

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      phone,
      role,
    });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      message: "Account ban gaya!",
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone || "", role: user.role },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // ✅ NAYA CHECK — sirf text allow karo, object/array nahi
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Email ya password galat format me hai." });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(400).json({ message: "Email ya password galat hai." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Email ya password galat hai." });
    }

    if (
      email.toLowerCase() === (process.env.ADMIN_EMAIL || "").toLowerCase() &&
      user.role !== "admin"
    ) {
      user.role = "admin";
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      message: "Login successful!",
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone || "", role: user.role },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- MERA PROFILE (LOGIN REQUIRED) ----------
// Profile page ke liye current user ki fresh details deta hai (naam, email, phone)
app.get("/api/auth/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User nahi mila." });
    }
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone || "",
      role: user.role,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- PASSWORD CHANGE KARO (LOGIN REQUIRED) ----------
// Body: { oldPassword, newPassword }
app.put("/api/auth/change-password", protect, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: "Purana aur naya password dono bharo." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Naya password kam se kam 6 characters ka hona chahiye." });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User nahi mila." });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Purana password galat hai." });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Password successfully change ho gaya." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email, phone, newPassword } = req.body;

    if (!email || !phone || !newPassword) {
      return res.status(400).json({ message: "Email, phone aur naya password sab bharo." });
    }
    if (typeof email !== "string" || typeof phone !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ message: "Invalid input format." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Naya password kam se kam 6 characters ka hona chahiye." });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    const genericFail = "Email ya phone number match nahi hua.";

    if (!user || !user.phone) {
      return res.status(400).json({ message: genericFail });
    }

    const normalize = (p) => String(p).replace(/[^0-9]/g, "").slice(-10);
    if (normalize(user.phone) !== normalize(phone)) {
      return res.status(400).json({ message: genericFail });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Password successfully reset ho gaya! Ab login karo." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== VPS / LINUX PLAN ROUTES ====================
// Dono categories ("vps" aur "linux") same routes use karte hain, sirf ?category= query se filter hota hai.

app.get("/api/vps/plans", async (req, res) => {
  try {
    const category = req.query.category === "linux" ? "linux" : "vps";
    // available: true hatao — saare plans aayenge
    const plans = await VpsPlan.find({ category }).sort({ createdAt: -1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- COUPON VALIDATE KARO (LOGIN REQUIRED) ----------
// Modal me "Apply" button dabane par ye call hoga — payment shuru karne se pehle
// discount preview dikhane ke liye. Ye order create NAHI karta, sirf check karta hai.
// Body: { code, vpsId, ram, category }
app.post("/api/coupons/validate", couponLimiter, protect, async (req, res) => {
  try {
    const { code, vpsId, ram, category } = req.body;
    const cat = category === "linux" ? "linux" : "vps";

    if (!code) {
      return res.status(400).json({ message: "Coupon code do." });
    }

    const plan = await VpsPlan.findOne({ vpsId, category: cat });
    if (!plan) {
      return res.status(404).json({ message: "Plan nahi mila." });
    }

    const selectedOption = plan.ramOptions.find((o) => o.ram === ram);
    if (!selectedOption) {
      return res.status(400).json({ message: "Ye RAM option is plan me nahi hai." });
    }

    const currentUser = await User.findById(req.userId).select("email");
    const result = await checkCouponValidity(code, selectedOption.price, req.userId, cat, currentUser?.email);

    if (!result.valid) {
      return res.status(400).json({ message: result.message });
    }

    res.json({
      message: result.message,
      originalPrice: selectedOption.price,
      discountAmount: result.discountAmount,
      finalAmount: result.finalAmount,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- STEP 1: PAYMENT SHURU KARO (LOGIN REQUIRED) ----------
// Body: { vpsId, ram, couponCode (optional), category }
// Ye order KHUD nahi banata — sirf Razorpay order banata hai aur pending record save karta hai
app.post("/api/vps/create-payment", protect, async (req, res) => {
  try {
    const { vpsId, ram, couponCode, category, gateway } = req.body;
    const selectedGateway = ["cashfree", "razorpay", "wallet"].includes(gateway) ? gateway : ACTIVE_GATEWAY;
    const cat = category === "linux" ? "linux" : "vps";

    const plan = await VpsPlan.findOne({ vpsId, category: cat });
    if (!plan) {
      return res.status(404).json({ message: "Plan nahi mila." });
    }

    // Price hamesha server se lo, frontend se kabhi trust mat karo
    const selectedOption = plan.ramOptions.find((o) => o.ram === ram);
    if (!selectedOption) {
      return res.status(400).json({ message: "Ye RAM option is plan me nahi hai." });
    }

    const user = await User.findById(req.userId);

    let discountAmount = 0;
    let finalAmount = selectedOption.price;
    let appliedCouponCode = undefined;

    // Coupon bheja gaya hai to server khud se dobara validate karega
    // (frontend ka discount kabhi trust nahi karna, warna koi bhi manually price ghata sakta hai)
    
    if (couponCode) {
      const result = await checkCouponValidity(couponCode, selectedOption.price, req.userId, cat, user?.email);
      if (!result.valid) {
        return res.status(400).json({ message: result.message });
      }
      discountAmount = result.discountAmount;
      finalAmount = result.finalAmount;
      appliedCouponCode = result.coupon.code;
    }
    if (selectedGateway === "wallet") {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();

        const wallet = await Wallet.findOne({ user: req.userId }).session(session);
        if (!wallet || wallet.balance < finalAmount) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ message: "Wallet me paise kam hain." });
        }

        wallet.balance -= finalAmount;
        await wallet.save({ session });

        const [order] = await Order.create([{
          user: req.userId,
          planName: plan.label || plan.nameOrIp,
          category: cat,
          vpsId: plan.vpsId,
          nameOrIp: plan.nameOrIp,
          ram: selectedOption.ram,
          price: selectedOption.price,
          couponCode: appliedCouponCode,
          discountAmount,
          finalAmount,
          status: "pending",
          paymentGateway: "wallet",
          paymentStatus: "paid",
        }], { session });

        await WalletTransaction.create([{
          user: req.userId,
          type: "debit",
          amount: finalAmount,
          description: `VPS Purchase: ${plan.nameOrIp}`,
          orderId: order._id,
          status: "completed",
        }], { session });

        if (appliedCouponCode) {
          await Coupon.updateOne({ code: appliedCouponCode }, { $inc: { usedCount: 1 } }).session(session);
        }

        await session.commitTransaction();
        session.endSession();

        try {
          const orderedByUser = await User.findById(order.user).select("name email");
          sendTelegramMessage(buildOrderAlertMessage({ user: orderedByUser, order }));
        } catch (e) {}

        return res.status(201).json({ gateway: "wallet", message: "Wallet se payment ho gaya! Order confirm.", order });
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        return res.status(500).json({ message: "Wallet payment fail ho gaya.", error: err.message });
      }
    }

    if (selectedGateway === "cashfree") {
      
      const cfOrderId = `sb_${vpsId}_${Date.now()}`;

      const cfOrder = await cashfreeClient.PGCreateOrder({
        order_id: cfOrderId,
        order_amount: finalAmount,
        order_currency: "INR",
        customer_details: {
          customer_id: String(req.userId),
          customer_name: user?.name || "Customer",
          customer_email: user?.email || "test@example.com",
          customer_phone: user?.phone || "9999999999",
        },
      });

      await PendingPayment.create({
        cfOrderId,
        paymentGateway: "cashfree",
        user: req.userId,
        vpsId: plan.vpsId,
        category: cat,
        nameOrIp: plan.nameOrIp,
        planName: plan.label || plan.nameOrIp,
        ram: selectedOption.ram,
        price: selectedOption.price,
        couponCode: appliedCouponCode,
        discountAmount,
        finalAmount,
      });

      return res.json({
        gateway: "cashfree",
        mode: process.env.CASHFREE_ENV === "production" ? "production" : "sandbox",
        orderId: cfOrderId,
        paymentSessionId: cfOrder.data.payment_session_id,
        discountAmount,
        finalAmount,
      });
    }

    const amountInPaise = finalAmount * 100;

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${vpsId}_${Date.now()}`,
    });

    await PendingPayment.create({
      razorpayOrderId: razorpayOrder.id,
      paymentGateway: "razorpay",
      user: req.userId,
      vpsId: plan.vpsId,
      category: cat,
      nameOrIp: plan.nameOrIp,
      planName: plan.label || plan.nameOrIp,
      ram: selectedOption.ram,
      price: selectedOption.price,
      couponCode: appliedCouponCode,
      discountAmount,
      finalAmount,
    });

    res.json({
      gateway: "razorpay",
      razorpayOrderId: razorpayOrder.id,
      amount: amountInPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      discountAmount,
      finalAmount,
    });
  } catch (err) {
    res.status(500).json({ message: "Payment order banane me error", error: err.message });
  }
});

// ---------- STEP 2: PAYMENT VERIFY KARO (LOGIN REQUIRED) ----------
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Signature valid hone par hi asli Order banega
app.post("/api/vps/verify-payment", protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Payment details incomplete hain." });
    }

    // ---- Signature verify: HMAC-SHA256(order_id + "|" + payment_id, key_secret) ----
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Payment verify nahi ho paya. Signature match nahi hui." });
    }

    // Pending record dhundo jo humne create-payment step me banaya tha
    const pending = await PendingPayment.findOneAndDelete({ razorpayOrderId: razorpay_order_id });
    if (!pending) {
      return res.status(404).json({ message: "Payment record nahi mila ya already process ho chuka hai." });
    }

    // Security: jisne payment shuru ki thi, wahi verify kar sakta hai
    if (pending.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Ye payment aapki nahi hai." });
    }
        // ✅ EXTRA CHECK — Razorpay ke apne server se seedha confirm karo
    // ki ye payment sach me successful hai aur sahi amount ka hai
    let razorpayPaymentDetails;
    try {
      razorpayPaymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (fetchErr) {
      return res.status(400).json({ message: "Payment details Razorpay se verify nahi ho paye." });
    }

    if (razorpayPaymentDetails.status !== "captured") {
      return res.status(400).json({ message: `Payment abhi captured nahi hua (status: ${razorpayPaymentDetails.status}).` });
    }

    if (razorpayPaymentDetails.order_id !== razorpay_order_id) {
      return res.status(400).json({ message: "Payment kisi aur order ka hai." });
    }

    const expectedAmountInPaise = Math.round(pending.finalAmount * 100);
    if (razorpayPaymentDetails.amount !== expectedAmountInPaise) {
      return res.status(400).json({ message: "Payment amount match nahi hua." });
    }

    // Ab jaake asli Order banega — payment success confirm hone ke baad
    const order = await Order.create({
      user: pending.user,
      planName: pending.planName,
      category: pending.category,
      vpsId: pending.vpsId,
      nameOrIp: pending.nameOrIp,
      ram: pending.ram,
      price: pending.price,
      couponCode: pending.couponCode,
      discountAmount: pending.discountAmount,
      finalAmount: pending.finalAmount,
      status: "pending", // fulfillment status - admin isko update karega
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      paymentStatus: "paid",
    });

    // Coupon ka usedCount badhao (agar coupon use hua tha)
    if (pending.couponCode) {
      await Coupon.updateOne({ code: pending.couponCode }, { $inc: { usedCount: 1 } });
    }

  
    // ---- Telegram alert: admin ko turant naya order notify karo ----
    // Ye fire-and-forget hai — Telegram fail bhi ho jaye to order response par asar nahi padega.
    try {
      const orderedByUser = await User.findById(order.user).select("name email");
      sendTelegramMessage(buildOrderAlertMessage({ user: orderedByUser, order }));
    } catch (alertErr) {
      console.error("Telegram alert bhejte waqt error:", alertErr.message);
    }

    res.status(201).json({ message: "Payment successful! Order confirm ho gaya.", order });
  } catch (err) {
    res.status(500).json({ message: "Payment verify karte waqt error", error: err.message });
  }
});
// ---------- CASHFREE VERIFY (LOGIN REQUIRED) ----------
app.post("/api/vps/verify-payment-cashfree", protect, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: "orderId zaroori hai." });
    }

    const cfOrder = await cashfreeClient.PGFetchOrder(orderId);
    if (cfOrder.data.order_status !== "PAID") {
      return res.status(400).json({ message: `Payment abhi confirm nahi hua (status: ${cfOrder.data.order_status}).` });
    }

     const pending = await PendingPayment.findOneAndDelete({ cfOrderId: orderId });
    if (!pending) {
      return res.status(404).json({ message: "Payment record nahi mila ya already process ho chuka hai." });
    }

    // ✅ EXTRA CHECK — amount match karo
    if (Number(cfOrder.data.order_amount) !== Number(pending.finalAmount)) {
      return res.status(400).json({ message: "Payment amount match nahi hua." });
    }

    if (pending.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Ye payment aapki nahi hai." });
    }

    let cfPaymentId;
    try {
      const payments = await cashfreeClient.PGOrderFetchPayments(orderId);
      const success = payments.data?.find((p) => p.payment_status === "SUCCESS");
      cfPaymentId = success?.cf_payment_id;
    } catch (e) {
      console.warn("Cashfree payment id fetch nahi ho paya:", e.message);
    }

    const order = await Order.create({
      user: pending.user,
      planName: pending.planName,
      category: pending.category,
      vpsId: pending.vpsId,
      nameOrIp: pending.nameOrIp,
      ram: pending.ram,
      price: pending.price,
      couponCode: pending.couponCode,
      discountAmount: pending.discountAmount,
      finalAmount: pending.finalAmount,
      status: "pending",
      cfOrderId: orderId,
      cfPaymentId,
      paymentGateway: "cashfree",
      paymentStatus: "paid",
    });

    if (pending.couponCode) {
      await Coupon.updateOne({ code: pending.couponCode }, { $inc: { usedCount: 1 } });
    }
    
    try {
      const orderedByUser = await User.findById(order.user).select("name email");
      sendTelegramMessage(buildOrderAlertMessage({ user: orderedByUser, order }));
    } catch (alertErr) {
      console.error("Telegram alert bhejte waqt error:", alertErr.message);
    }

    res.status(201).json({ message: "Payment successful! Order confirm ho gaya.", order });
  } catch (err) {
    res.status(500).json({ message: "Payment verify karte waqt error", error: err.message });
  }
});

// ---------- MERE ORDERS (LOGIN REQUIRED) ----------
// Optional ?category=vps|linux se filter kar sakte ho
app.get("/api/vps/my-orders", protect, async (req, res) => {
  try {
    const filter = { user: req.userId };
    if (req.query.category === "vps" || req.query.category === "linux") {
      filter.category = req.query.category;
    }
    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// ---------- FORMAT REQUEST BHEJO (LOGIN REQUIRED) ----------
// User apne active/delivered VPS ke liye format/reinstall request bhejta hai
app.post("/api/vps/request-format", protect, async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: "Order ID zaroori hai." });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: "Problem likhna zaroori hai." });
    }

    const order = await Order.findOne({ _id: orderId, user: req.userId });
    if (!order) {
      return res.status(404).json({ message: "Order nahi mila." });
    }

    if (order.status !== "delivered" && order.status !== "active") {
      return res.status(400).json({ message: "Ye order abhi active nahi hai." });
    }

    if (order.formatStatus === "pending") {
      return res.status(400).json({ message: "Aapka pichla format request already pending hai. Admin approve karne ka wait karo." });
    }

    order.formatStatus = "pending";
    order.formatRequestedAt = new Date();
    order.formatReason = reason.trim();
    order.formatSeenByUser = true;
    await order.save();

    try {
      const user = await User.findById(req.userId);
      const msg = [
        `🔄 <b>Naya Format Request!</b>`,
        ``,
        `👤 <b>User:</b> ${user?.name || "Unknown"}`,
        `📧 <b>Email:</b> ${user?.email || "Unknown"}`,
        `🌐 <b>Plan/IP:</b> ${order.nameOrIp || order.planName}`,
        `🆔 <b>Order ID:</b> <code>${order._id}</code>`,
        `📝 <b>Problem:</b> ${escapeHtml(reason.trim())}`,
        ``,
        `⚠️ <b>Admin Action Required:</b> Format karke Approve karo.`
      ].join("\n");
      sendTelegramMessage(msg);
    } catch (alertErr) {
      console.error("Telegram alert error:", alertErr.message);
    }

    res.json({ message: "Format request bheji gayi! Admin jald hi process karega." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// ==================== USER-SERVER PROXY ROUTES ====================

// ---------- STEP A: CONNECT + OS DETECT KARO (install nahi) ----------
app.post("/api/proxy/detect", protect, proxyConnectLimiter, async (req, res) => {
  const { ip, sshUsername, sshPassword } = req.body;
  if (!ip || !sshUsername || !sshPassword) {
    return res.status(400).json({ message: "IP, SSH username aur password sab zaroori hai." });
  }
  try {
    const result = await detectServerOS({ ip, username: sshUsername, password: sshPassword });
    res.json({ success: true, os: result.os, port: 3128 });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server se connect nahi ho paya.", error: err.message });
  }
});

// ---------- STEP B: ACTUAL PROXY INSTALL KARO ----------
// Body: { ip, sshUsername, sshPassword, proxyUsername, proxyPassword }
app.post("/api/proxy/install", protect, proxyConnectLimiter, async (req, res) => {
  const { ip, sshUsername, sshPassword, proxyUsername, proxyPassword, forceReinstall } = req.body;
  if (!ip || !sshUsername || !sshPassword || !proxyUsername || !proxyPassword) {
    return res.status(400).json({ message: "Sab fields zaroori hain." });
  }

  const serverDoc = await ProxyServer.create({
    user: req.userId,
    ip,
    sshUsername,
    sshPasswordEncrypted: encryptSecret(sshPassword),
    status: "connecting",
  });

  try {
    const result = await setupProxyOnServer({
      ip, username: sshUsername, password: sshPassword, proxyUsername, proxyPassword,
      forceReinstall: !!forceReinstall,
    });

    serverDoc.status = "active";
    serverDoc.proxyPort = result.proxyPort;
    serverDoc.proxyUsername = result.proxyUsername;
    serverDoc.proxyPasswordEncrypted = encryptSecret(result.proxyPassword);
    await serverDoc.save();

    res.json({ message: "Proxy install ho gaya!", proxy: result });
  } catch (err) {
    serverDoc.status = "failed";
    serverDoc.lastError = err.message;
    await serverDoc.save();

    if (err.alreadyInstalled) {
      return res.status(409).json({
        alreadyInstalled: true,
        message: "Squid proxy is server par pehle se installed hai.",
      });
    }

    res.status(500).json({ message: "Install nahi ho paya.", error: err.message });
  }
});

// ---------- MERE SAARE CONNECTED PROXY SERVERS (LOGIN REQUIRED) ----------
app.get("/api/proxy/my-servers", protect, async (req, res) => {
  try {
    const servers = await ProxyServer.find({ user: req.userId })
      .select("-sshPasswordEncrypted -proxyPasswordEncrypted")
      .sort({ createdAt: -1 });
    res.json(servers);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// ==================== HOSTHEAVEN ROUTES (USER) ====================
async function findOwnedOrderByVmId(userId, vmId) {
  return Order.findOne({ user: userId, vmId: Number(vmId) });
}

app.get("/api/vps/my-hostheaven-vps", protect, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.userId, vmId: { $ne: null } });
    if (!orders.length) return res.json({ success: true, vms: [] });
    const allVms = await getVmOverviewCached();
    const orderVmIds = orders.map(o => Number(o.vmId));
    const vms = (allVms.orders || [])
      .filter(v => orderVmIds.includes(Number(v.vmId)))
      .map(v => {
        const o = orders.find(x => Number(x.vmId) === Number(v.vmId));
        return { ...v, deliveryPassword: o.deliveryPassword, orderId: o._id, planName: o.nameOrIp || o.planName };
      });
    res.json({ success: true, vms });
  } catch (err) {
    res.json({ success: false, vms: [], message: err.message });
  }
});

app.post("/api/vps/hostheaven-control", protect, async (req, res) => {
  try {
    const { vmId, action } = req.body;
    const order = await findOwnedOrderByVmId(req.userId, vmId);
    if (!order) return res.status(403).json({ success: false, message: "Ye VM aapka nahi hai." });
    const data = await hostHeavenAPI(`/api/users/${hostHeavenUserId}/vms/${vmId}/control?action=${action}`, "POST", {});
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post("/api/vps/hostheaven-change-password", protect, async (req, res) => {
  try {
    const { vmId, newPassword } = req.body;
    const order = await findOwnedOrderByVmId(req.userId, vmId);
    if (!order) return res.status(403).json({ success: false, message: "Ye VM aapka nahi hai." });
    const tok = await getHostHeavenToken();
    const result = await fetch(`${HOSTHEAVEN_BASE}/api/users/${hostHeavenUserId}/vms/${vmId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "X-Reseller-Domain": RESELLER_DOMAIN },
      body: JSON.stringify({ password: newPassword }),
    });
    const data = await result.json();
    order.deliveryPassword = newPassword;
    await order.save();
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get("/api/vps/hostheaven-isos/:vmId", protect, async (req, res) => {
  try {
    const { vmId } = req.params;
    const order = await findOwnedOrderByVmId(req.userId, vmId);
    if (!order) return res.status(403).json({ success: false, message: "Ye VM aapka nahi hai." });
    const vmDetails = await hostHeavenAPI(`/api/users/orders/${vmId}/details`);
    const zoneId = vmDetails.zoneId;
    const isos = await hostHeavenAPI(`/api/users/zones/${zoneId}/isos`);
    res.json({ success: true, isos, zoneId });
  } catch (err) {
    res.json({ success: false, isos: [], message: err.message });
  }
});

const rebuildInProgress = new Set();
app.post("/api/vps/hostheaven-rebuild", protect, async (req, res) => {
  try {
    const { vmId, isoId } = req.body;
    const order = await findOwnedOrderByVmId(req.userId, vmId);
    if (!order) return res.status(403).json({ success: false, message: "Ye VM aapka nahi hai." });
    if (rebuildInProgress.has(String(vmId))) {
      return res.json({ success: false, message: "Rebuild already chal rahi hai, thodi der wait karo." });
    }
    rebuildInProgress.add(String(vmId));
    const vmDetails = await hostHeavenAPI(`/api/users/orders/${vmId}/details`);
    const zoneId = vmDetails.zoneId;
    const zoneIsos = await hostHeavenAPI(`/api/users/zones/${zoneId}/isos`);
    const validIso = zoneIsos.find(iso => iso.id === Number(isoId));
    if (!validIso) {
      rebuildInProgress.delete(String(vmId));
      return res.json({ success: false, message: `Selected OS zone ke liye valid nahi. Valid: ${zoneIsos.map(i => i.name).join(", ")}` });
    }
    const tok = await getHostHeavenToken();
    const result = await fetch(`${HOSTHEAVEN_BASE}/api/users/${hostHeavenUserId}/vms/${vmId}/rebuild?isoId=${validIso.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "X-Reseller-Domain": RESELLER_DOMAIN },
      body: JSON.stringify({}),
    });
    const data = await result.json();
    setTimeout(() => rebuildInProgress.delete(String(vmId)), 3 * 60 * 1000);
    if (data.message === "Rebuild initiated.") {
      res.json({ success: true, data });
    } else {
      rebuildInProgress.delete(String(vmId));
      res.json({ success: false, message: data.message || "Failed" });
    }
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get("/api/vps/hostheaven-lock-status/:vmId", protect, async (req, res) => {
  try {
    const data = await hostHeavenAPI(`/api/vms/${req.params.vmId}/lock-status`);
    const isLocked = data.isLocked || ["SUSPENDED", "LOCKED", "ERROR"].includes(data.status);
    res.json({ success: true, isLocked, status: data.status || "" });
  } catch (err) {
    res.json({ success: false, isLocked: false });
  }
});

app.get("/api/admin/hostheaven-live-vms", protect, isAdmin, async (req, res) => {
  try {
    const data = await getVmOverviewCached();
    const vms = (data.orders || []).map(v => ({
      vmId: v.vmId, ip: v.ipAddress, os: v.os || "", plan: v.serverPlan || "", status: v.liveState || "",
    }));
    res.json({ success: true, vms });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});
// ==================== END HOSTHEAVEN ROUTES ====================
// ==================== WALLET ROUTES ====================

// ---------- BALANCE DEKHO ----------
app.get("/api/wallet/balance", protect, async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ user: req.userId });
    res.json({ balance: wallet ? wallet.balance : 0 });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== ADMIN WALLET ROUTES ====================

// Rate limit — galti se ya kisi script se bulk balance edit na ho paye
const adminWalletLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { message: "Bahut zyada wallet actions ho gaye. Thodi der baad try karo." },
});

// ---------- SAARE USERS KA WALLET BALANCE (LIST) ----------
app.get("/api/admin/wallets", protect, isAdmin, async (req, res) => {
  try {
    const users = await User.find().select("name email phone").sort({ name: 1 });
    const wallets = await Wallet.find();

    const walletMap = {};
    wallets.forEach((w) => { walletMap[w.user.toString()] = w.balance; });

    const result = users.map((u) => ({
      userId: u._id,
      name: u.name,
      email: u.email,
      phone: u.phone || "",
      balance: walletMap[u._id.toString()] || 0,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- KISI EK USER KI TRANSACTION HISTORY ----------
app.get("/api/admin/wallets/:userId/transactions", protect, isAdmin, async (req, res) => {
  try {
    const transactions = await WalletTransaction.find({ user: req.params.userId })
      .populate("adminId", "name email")
      .sort({ createdAt: -1 })
      .limit(200);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- WALLET BALANCE MANUALLY ADJUST KARO (CREDIT / DEBIT) ----------
// Body: { amount, type: "credit"|"debit", reason }
// Security:
//  - Amount hamesha positive number, type explicit "credit"/"debit" (sign-flip galti se na ho)
//  - Reason MANDATORY hai — har admin action ka audit trail rahega
//  - Debit tabhi hoga jab balance sufficient ho (negative balance allowed nahi)
//  - Mongo transaction se balance update + log ek saath atomic hote hain
//  - adminId save hota hai — pata chalega kis admin ne kab kya kiya
app.put("/api/admin/wallets/:userId", protect, isAdmin, adminWalletLimiter, async (req, res) => {
  try {
    const { amount, type, reason } = req.body;
    const numAmount = Number(amount);

    if (!numAmount || numAmount <= 0 || !isFinite(numAmount)) {
      return res.status(400).json({ message: "Amount ek valid positive number hona chahiye." });
    }
    if (!["credit", "debit"].includes(type)) {
      return res.status(400).json({ message: "Type 'credit' ya 'debit' hi ho sakta hai." });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: "Reason likhna zaroori hai (audit ke liye)." });
    }

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ message: "User nahi mila." });
    }

    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      let wallet = await Wallet.findOne({ user: req.params.userId }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{ user: req.params.userId, balance: 0 }], { session });
        wallet = created[0];
      }

      if (type === "debit" && wallet.balance < numAmount) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `User ka balance sirf ₹${wallet.balance} hai, itna debit nahi ho sakta.` });
      }

      wallet.balance += type === "credit" ? numAmount : -numAmount;
      await wallet.save({ session });

      await WalletTransaction.create([{
        user: req.params.userId,
        type,
        amount: numAmount,
        description: `Admin Adjustment: ${reason.trim()}`,
        adminId: req.userId,
        status: "completed",
      }], { session });

      await session.commitTransaction();
      session.endSession();

      // Fire-and-forget Telegram alert — koi bhi manual wallet edit turant log ho
      try {
        const admin = await User.findById(req.userId).select("name email");
        sendTelegramMessage(
          [
            `⚙️ <b>Admin Wallet Adjustment</b>`,
            ``,
            `👤 <b>User:</b> ${escapeHtml(targetUser.name)} (${escapeHtml(targetUser.email)})`,
            `🛠️ <b>Admin:</b> ${escapeHtml(admin?.name)} (${escapeHtml(admin?.email)})`,
            `${type === "credit" ? "➕" : "➖"} <b>${type.toUpperCase()}:</b> ₹${numAmount}`,
            `📝 <b>Reason:</b> ${escapeHtml(reason.trim())}`,
            `💰 <b>Naya Balance:</b> ₹${wallet.balance}`,
          ].join("\n")
        );
      } catch (e) {}

      res.json({ message: "Wallet update ho gaya.", balance: wallet.balance });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// ==================== END ADMIN WALLET ROUTES ====================

// ---------- TRANSACTION HISTORY ----------
app.get("/api/wallet/transactions", protect, async (req, res) => {
  try {
    const transactions = await WalletTransaction.find({ user: req.userId })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- STEP 1: WALLET RECHARGE ORDER BANAO (Razorpay) ----------
app.post("/api/wallet/create-recharge-order", protect, async (req, res) => {
  try {
    const { amount } = req.body;
    const amt = Number(amount);

    if (!amt || amt < 10) {
      return res.status(400).json({ message: "Minimum ₹10 recharge karna hoga." });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amt * 100),
      currency: "INR",
      receipt: `wallet_${req.userId}_${Date.now()}`,
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    res.status(500).json({ message: "Recharge order banane me error", error: err.message });
  }
});

// ---------- STEP 2: PAYMENT VERIFY + BALANCE ADD ----------
app.post("/api/wallet/verify-recharge", protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !amount) {
      return res.status(400).json({ message: "Payment details incomplete hain." });
    }

    // Signature verify
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Signature match nahi hui." });
    }

    // Isi payment ID se pehle koi transaction already ban chuka to duplicate credit rok do
    const alreadyDone = await WalletTransaction.findOne({ razorpayPaymentId: razorpay_payment_id });
    if (alreadyDone) {
      return res.status(400).json({ message: "Ye payment already process ho chuka hai." });
    }

    // Razorpay se direct confirm karo — amount aur status
    let paymentDetails;
    try {
      paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (e) {
      return res.status(400).json({ message: "Payment Razorpay se verify nahi ho paya." });
    }

    if (paymentDetails.status !== "captured") {
      return res.status(400).json({ message: `Payment abhi captured nahi hua (status: ${paymentDetails.status}).` });
    }
    if (paymentDetails.order_id !== razorpay_order_id) {
      return res.status(400).json({ message: "Payment kisi aur order ka hai." });
    }

    const expectedPaise = Math.round(Number(amount) * 100);
    if (paymentDetails.amount !== expectedPaise) {
      return res.status(400).json({ message: "Amount match nahi hua." });
    }

    // Pehle transaction record banao — unique index isko atomically duplicate hone se rokega.
    // Agar ye create fail ho gaya (kyunki dusri request already same payment id use kar chuki hai),
    // to balance ko haath mat lagao — isse double-credit fraud nahi ho sakta.
    let transactionRecord;
    try {
      transactionRecord = await WalletTransaction.create({
        user: req.userId,
        type: "credit",
        amount: Number(amount),
        description: "Wallet Recharge",
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        status: "completed",
      });
    } catch (dupErr) {
      if (dupErr.code === 11000) {
        return res.status(400).json({ message: "Ye payment already process ho chuka hai." });
      }
      throw dupErr;
    }

    // Transaction record safal bana, ab hi balance add karo
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.userId },
      { $inc: { balance: Number(amount) } },
      { new: true, upsert: true }
    );

    res.json({ message: "Wallet recharge ho gaya!", balance: wallet.balance });
  } catch (err) {
    res.status(500).json({ message: "Verify karte waqt error", error: err.message });
  }
});

// ==================== ADMIN ROUTES ====================


app.get("/api/admin/users", protect, isAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.get("/api/admin/orders", protect, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user", "name email phone")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.put("/api/admin/orders/:id", protect, isAdmin, async (req, res) => {
  try {
    const { status, deliveryIp, deliveryUsername, deliveryPassword, deliveryOS, validityDays } = req.body;

    const updateFields = {};
    if (req.body.vmId !== undefined) updateFields.vmId = Number(req.body.vmId) || null;
    if (status !== undefined) updateFields.status = status;
    if (deliveryIp !== undefined) updateFields.deliveryIp = deliveryIp;
    if (deliveryUsername !== undefined) updateFields.deliveryUsername = deliveryUsername;
    if (deliveryPassword !== undefined) updateFields.deliveryPassword = deliveryPassword;
    if (deliveryOS !== undefined) updateFields.deliveryOS = deliveryOS;

    if (status === "delivered") {
      const days = Number(validityDays) > 0 ? Number(validityDays) : 30;
      const deliveredAt = new Date();
      updateFields.deliveredAt = deliveredAt;
      updateFields.validityDays = days;
      updateFields.expiresAt = new Date(deliveredAt.getTime() + days * 24 * 60 * 60 * 1000);
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order nahi mila." });
    }

    res.json({ message: "Order update ho gaya.", order });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- ORDER DELETE KARO (ADMIN ONLY) ----------
app.delete("/api/admin/orders/:id", protect, isAdmin, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order nahi mila." });
    }
    res.json({ message: "Order delete ho gaya." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// ---------- ADMIN: SAARE PENDING FORMAT REQUESTS DEKHO ----------
app.get("/api/admin/format-requests", protect, isAdmin, async (req, res) => {
  try {
    const requests = await Order.find({ formatStatus: "pending" })
      .populate("user", "name email phone")
      .sort({ formatRequestedAt: -1 });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- ADMIN: FORMAT REQUEST APPROVE KARO ----------
app.put("/api/admin/format-requests/:id/approve", protect, isAdmin, async (req, res) => {
  try {
    const { solution, deliveryIp, deliveryUsername, deliveryPassword, deliveryOS } = req.body;
    if (!solution || !solution.trim()) {
      return res.status(400).json({ message: "Solution likhna zaroori hai." });
    }

    const updateFields = {
      formatStatus: "none",
      lastFormattedAt: new Date(),
      formatSolution: solution.trim(),
      formatSeenByUser: false,
    };
    if (deliveryIp !== undefined && deliveryIp.trim()) updateFields.deliveryIp = deliveryIp.trim();
    if (deliveryUsername !== undefined && deliveryUsername.trim()) updateFields.deliveryUsername = deliveryUsername.trim();
    if (deliveryPassword !== undefined && deliveryPassword.trim()) updateFields.deliveryPassword = deliveryPassword.trim();
    if (deliveryOS !== undefined && deliveryOS.trim()) updateFields.deliveryOS = deliveryOS.trim();

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true }
    );
    if (!order) {
      return res.status(404).json({ message: "Order nahi mila." });
    }
    res.json({ message: "Format request approve ho gayi!", order });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
app.put("/api/vps/orders/:id/ack-format", protect, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.userId });
    if (!order) {
      return res.status(404).json({ message: "Order nahi mila." });
    }
    order.formatSeenByUser = true;
    await order.save();
    res.json({ message: "ok" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Optional ?category=vps|linux — agar diya hai to sirf usi category ke plans aayenge,
// warna (jaise purane admin panel calls) sab plans aa jayenge.
app.get("/api/admin/vps-plans", protect, isAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.category === "vps" || req.query.category === "linux") {
      filter.category = req.query.category;
    }
    const plans = await VpsPlan.find(filter).sort({ createdAt: -1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post("/api/admin/vps-plans", protect, isAdmin, async (req, res) => {
  try {
    const { vpsId, nameOrIp, label, company, ramOptions, bestSeller, category } = req.body;

    if (!vpsId || !nameOrIp || !ramOptions || ramOptions.length === 0) {
      return res.status(400).json({ message: "VPS ID, Name/IP aur kam se kam ek RAM option zaroori hai." });
    }

    const existing = await VpsPlan.findOne({ vpsId });
    if (existing) {
      return res.status(400).json({ message: "Ye VPS ID pehle se add hai." });
    }

    const plan = await VpsPlan.create({
      vpsId,
      nameOrIp,
      label,
      company,
      ramOptions,
      bestSeller: !!bestSeller,
      category: category === "linux" ? "linux" : "vps",
    });
    res.status(201).json({ message: "Plan add ho gaya!", plan });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.put("/api/admin/vps-plans/:id", protect, isAdmin, async (req, res) => {
  try {
    const { nameOrIp, label, company, ramOptions, available, bestSeller, category } = req.body;

    const updateFields = {};
    if (nameOrIp !== undefined) updateFields.nameOrIp = nameOrIp;
    if (label !== undefined) updateFields.label = label;
    if (company !== undefined) updateFields.company = company;
    if (ramOptions !== undefined) updateFields.ramOptions = ramOptions;
    if (available !== undefined) updateFields.available = available;
    if (bestSeller !== undefined) updateFields.bestSeller = bestSeller;
    if (category !== undefined) updateFields.category = category === "linux" ? "linux" : "vps";

    const plan = await VpsPlan.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    );

    if (!plan) {
      return res.status(404).json({ message: "Plan nahi mila." });
    }

    res.json({ message: "Plan update ho gaya.", plan });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.delete("/api/admin/vps-plans/:id", protect, isAdmin, async (req, res) => {
  try {
    const plan = await VpsPlan.findByIdAndDelete(req.params.id);
    if (!plan) {
      return res.status(404).json({ message: "Plan nahi mila." });
    }
    res.json({ message: "Plan delete ho gaya." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- ADMIN COUPON ROUTES ----------
app.get("/api/admin/coupons", protect, isAdmin, async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post("/api/admin/coupons", protect, isAdmin, async (req, res) => {
  try {
    const {
      code, discountType, discountValue, maxDiscountAmount,
      minOrderAmount, usageLimit, perUserLimit, expiresAt, active,
      category, assignedToEmail,
    } = req.body;

    if (!code || !discountType || !discountValue) {
      return res.status(400).json({ message: "Code, discount type aur discount value zaroori hai." });
    }

    const existing = await Coupon.findOne({ code: code.trim().toUpperCase() });
    if (existing) {
      return res.status(400).json({ message: "Ye coupon code pehle se hai." });
    }

    const coupon = await Coupon.create({
      code: code.trim().toUpperCase(),
      discountType,
      discountValue,
      maxDiscountAmount,
      minOrderAmount,
      usageLimit,
      perUserLimit,
      expiresAt,
      active: active !== undefined ? !!active : true,
      category: (category === "vps" || category === "linux") ? category : "both",
      assignedToEmail: assignedToEmail ? assignedToEmail.trim().toLowerCase() : null,
    });

    res.status(201).json({ message: "Coupon add ho gaya!", coupon });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.put("/api/admin/coupons/:id", protect, isAdmin, async (req, res) => {
  try {
    const {
      discountType, discountValue, maxDiscountAmount,
      minOrderAmount, usageLimit, perUserLimit, expiresAt, active,
      category, assignedToEmail,
    } = req.body;

    const updateFields = {};
    if (discountType !== undefined) updateFields.discountType = discountType;
    if (discountValue !== undefined) updateFields.discountValue = discountValue;
    if (maxDiscountAmount !== undefined) updateFields.maxDiscountAmount = maxDiscountAmount;
    if (minOrderAmount !== undefined) updateFields.minOrderAmount = minOrderAmount;
    if (usageLimit !== undefined) updateFields.usageLimit = usageLimit;
    if (perUserLimit !== undefined) updateFields.perUserLimit = perUserLimit;
    if (expiresAt !== undefined) updateFields.expiresAt = expiresAt;
    if (active !== undefined) updateFields.active = active;
    if (category !== undefined) updateFields.category = (category === "vps" || category === "linux") ? category : "both";
    if (assignedToEmail !== undefined) updateFields.assignedToEmail = assignedToEmail ? assignedToEmail.trim().toLowerCase() : null;

    const coupon = await Coupon.findByIdAndUpdate(req.params.id, updateFields, { new: true });
    if (!coupon) {
      return res.status(404).json({ message: "Coupon nahi mila." });
    }

    res.json({ message: "Coupon update ho gaya.", coupon });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.delete("/api/admin/coupons/:id", protect, isAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: "Coupon nahi mila." });
    }
    res.json({ message: "Coupon delete ho gaya." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
// ==================== NOTICE ROUTES (PUBLIC) ====================
app.get("/api/notices", async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { active: true };
    
    if (category === "vps" || category === "linux") {
      filter.$or = [
        { category: category },
        { category: "all" }
      ];
    }
    
    const notices = await Notice.find(filter)
      .sort({ createdAt: -1 })
      .limit(10).lean();
    
    res.json(notices);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== NOTICE ROUTES (ADMIN) ====================
app.get("/api/admin/notices", protect, isAdmin, async (req, res) => {
  try {
    const notices = await Notice.find()
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });
    res.json(notices);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post("/api/admin/notices", protect, isAdmin, async (req, res) => {
  try {
    const { title, message, category } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({ message: "Title aur message dono bharo." });
    }
    
    const notice = await Notice.create({
      title,
      message,
      category: category || "all",
      createdBy: req.userId,
    });
    
    res.status(201).json({ message: "Notice create ho gaya!", notice });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.delete("/api/admin/notices/:id", protect, isAdmin, async (req, res) => {
  try {
    const notice = await Notice.findByIdAndDelete(req.params.id);
    if (!notice) {
      return res.status(404).json({ message: "Notice nahi mila." });
    }
    res.json({ message: "Notice delete ho gaya." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.put("/api/admin/notices/:id", protect, isAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    const notice = await Notice.findByIdAndUpdate(
      req.params.id,
      { active },
      { new: true }
    );
    if (!notice) {
      return res.status(404).json({ message: "Notice nahi mila." });
    }
    res.json({ message: "Notice update ho gaya.", notice });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== BASE ROUTE ====================
app.get("/", (req, res) => {
  res.send("ServerBazar API chal raha hai 🚀");
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 5000;
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => console.log(`Server chal raha hai port ${PORT} par`));
};
startServer();