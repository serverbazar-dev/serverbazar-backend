const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Razorpay = require("razorpay");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
connectDB();

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
    vpsId: { type: String },
    nameOrIp: { type: String }, // plan ka listed IP/name jo user ne khareeda
    ram: { type: String },
    price: { type: Number, required: true },
    status: { type: String, default: "pending" }, // pending | active | delivered | cancelled
    // ---- payment info ----
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    paymentStatus: { type: String, default: "paid" }, // order sirf tabhi banta hai jab payment verify ho jaye
    // ---- delivery details (admin fill karega jab VPS actually deliver kare) ----
    deliveryIp: { type: String },
    deliveryUsername: { type: String },
    deliveryPassword: { type: String },
    deliveryOS: { type: String },
    deliveredAt: { type: Date },
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
  },
  { timestamps: true }
);
const VpsPlan = mongoose.model("VpsPlan", vpsPlanSchema);

// ---- Payment abhi pending hai, ye temporary record hai jab tak Razorpay confirm na kare ----
// 15 min me khud expire ho jayega agar user payment complete nahi karta (TTL index)
const pendingPaymentSchema = new mongoose.Schema(
  {
    razorpayOrderId: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    vpsId: { type: String, required: true },
    nameOrIp: { type: String },
    planName: { type: String, required: true },
    ram: { type: String, required: true },
    price: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now, expires: 900 }, // 900s = 15 min TTL
  }
);
const PendingPayment = mongoose.model("PendingPayment", pendingPaymentSchema);

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

// ==================== AUTH ROUTES ====================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Sab fields bharo." });
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
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
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
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ==================== VPS ROUTES ====================

app.get("/api/vps/plans", async (req, res) => {
  try {
    const plans = await VpsPlan.find({ available: true }).sort({ createdAt: -1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- STEP 1: PAYMENT SHURU KARO (LOGIN REQUIRED) ----------
// Body: { vpsId, ram }
// Ye order KHUD nahi banata — sirf Razorpay order banata hai aur pending record save karta hai
app.post("/api/vps/create-payment", protect, async (req, res) => {
  try {
    const { vpsId, ram } = req.body;

    const plan = await VpsPlan.findOne({ vpsId });
    if (!plan) {
      return res.status(404).json({ message: "Plan nahi mila." });
    }

    // Price hamesha server se lo, frontend se kabhi trust mat karo
    const selectedOption = plan.ramOptions.find((o) => o.ram === ram);
    if (!selectedOption) {
      return res.status(400).json({ message: "Ye RAM option is plan me nahi hai." });
    }

    const amountInPaise = selectedOption.price * 100;

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${vpsId}_${Date.now()}`,
    });

    // Pending record — jab tak payment verify nahi hota, actual Order nahi banega
    await PendingPayment.create({
      razorpayOrderId: razorpayOrder.id,
      user: req.userId,
      vpsId: plan.vpsId,
      nameOrIp: plan.nameOrIp,
      planName: plan.label || plan.nameOrIp,
      ram: selectedOption.ram,
      price: selectedOption.price,
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: amountInPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID, // sirf key_id frontend ko jata hai, secret nahi
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
    const pending = await PendingPayment.findOne({ razorpayOrderId: razorpay_order_id });
    if (!pending) {
      return res.status(404).json({ message: "Payment record nahi mila ya expire ho gaya." });
    }

    // Security: jisne payment shuru ki thi, wahi verify kar sakta hai
    if (pending.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Ye payment aapki nahi hai." });
    }

    // Ab jaake asli Order banega — payment success confirm hone ke baad
    const order = await Order.create({
      user: pending.user,
      planName: pending.planName,
      vpsId: pending.vpsId,
      nameOrIp: pending.nameOrIp,
      ram: pending.ram,
      price: pending.price,
      status: "pending", // fulfillment status - admin isko update karega
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      paymentStatus: "paid",
    });

    await PendingPayment.deleteOne({ _id: pending._id });

    res.status(201).json({ message: "Payment successful! Order confirm ho gaya.", order });
  } catch (err) {
    res.status(500).json({ message: "Payment verify karte waqt error", error: err.message });
  }
});

// ---------- MERE ORDERS (LOGIN REQUIRED) ----------
app.get("/api/vps/my-orders", protect, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.userId }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
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
    const { status, deliveryIp, deliveryUsername, deliveryPassword, deliveryOS } = req.body;

    const updateFields = {};
    if (status !== undefined) updateFields.status = status;
    if (deliveryIp !== undefined) updateFields.deliveryIp = deliveryIp;
    if (deliveryUsername !== undefined) updateFields.deliveryUsername = deliveryUsername;
    if (deliveryPassword !== undefined) updateFields.deliveryPassword = deliveryPassword;
    if (deliveryOS !== undefined) updateFields.deliveryOS = deliveryOS;
    if (status === "delivered") updateFields.deliveredAt = new Date();

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

app.get("/api/admin/vps-plans", protect, isAdmin, async (req, res) => {
  try {
    const plans = await VpsPlan.find().sort({ createdAt: -1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post("/api/admin/vps-plans", protect, isAdmin, async (req, res) => {
  try {
    const { vpsId, nameOrIp, label, company, ramOptions } = req.body;

    if (!vpsId || !nameOrIp || !ramOptions || ramOptions.length === 0) {
      return res.status(400).json({ message: "VPS ID, Name/IP aur kam se kam ek RAM option zaroori hai." });
    }

    const existing = await VpsPlan.findOne({ vpsId });
    if (existing) {
      return res.status(400).json({ message: "Ye VPS ID pehle se add hai." });
    }

    const plan = await VpsPlan.create({ vpsId, nameOrIp, label, company, ramOptions });
    res.status(201).json({ message: "VPS plan add ho gaya!", plan });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.put("/api/admin/vps-plans/:id", protect, isAdmin, async (req, res) => {
  try {
    const { nameOrIp, label, company, ramOptions, available } = req.body;

    const updateFields = {};
    if (nameOrIp !== undefined) updateFields.nameOrIp = nameOrIp;
    if (label !== undefined) updateFields.label = label;
    if (company !== undefined) updateFields.company = company;
    if (ramOptions !== undefined) updateFields.ramOptions = ramOptions;
    if (available !== undefined) updateFields.available = available;

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

// ==================== BASE ROUTE ====================
app.get("/", (req, res) => {
  res.send("ServerBazar API chal raha hai 🚀");
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server chal raha hai port ${PORT} par`));