const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
// .env / Render me ADMIN_EMAIL aur ADMIN_PASSWORD set karo,
// server start hote hi ye check karega — agar wo email exist nahi karti to
// khud admin account bana dega, agar exist karti hai to sirf role admin kar dega.
async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) return; // agar set nahi kiya to skip

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
    role: { type: String, default: "user" }, // "user" ya "admin"
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    planName: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: "pending" },
  },
  { timestamps: true }
);
const Order = mongoose.model("Order", orderSchema);

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

// ==================== MIDDLEWARE (admin check - protect ke baad lagta hai) ====================
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

// ---------- REGISTER ----------
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

    // Agar ye email .env wali ADMIN_EMAIL se match kare, to isko admin bana do
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

// ---------- LOGIN ----------
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

    // Agar ye email ADMIN_EMAIL se match kare aur abhi tak admin nahi bana, to promote kar do
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

const plans = [
  { id: 1, name: "Starter VPS", ram: "2GB RAM", cpu: "1 vCPU", storage: "40GB SSD", bandwidth: "1TB", price: 299 },
  { id: 2, name: "Business VPS", ram: "4GB RAM", cpu: "2 vCPU", storage: "80GB SSD", bandwidth: "2TB", price: 599 },
  { id: 3, name: "Pro VPS", ram: "8GB RAM", cpu: "4 vCPU", storage: "160GB SSD", bandwidth: "4TB", price: 1199 },
  { id: 4, name: "Enterprise VPS", ram: "16GB RAM", cpu: "8 vCPU", storage: "320GB SSD", bandwidth: "8TB", price: 2399 },
];

// ---------- PLANS LIST (public, login ki zarurat nahi) ----------
app.get("/api/vps/plans", (req, res) => {
  res.json(plans);
});

// ---------- ORDER PLACE (LOGIN REQUIRED) ----------
app.post("/api/vps/order", protect, async (req, res) => {
  try {
    const { planId } = req.body;
    const plan = plans.find((p) => p.id === planId);

    if (!plan) {
      return res.status(404).json({ message: "Plan nahi mila." });
    }

    const order = await Order.create({
      user: req.userId,
      planName: plan.name,
      price: plan.price,
    });

    res.status(201).json({ message: "Order successful! Team aapse contact karegi.", order });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
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

// ---------- SAARE USERS DEKHO (ADMIN ONLY) ----------
app.get("/api/admin/users", protect, isAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ---------- SAARE ORDERS DEKHO (ADMIN ONLY) ----------
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

// ---------- ORDER STATUS UPDATE KARO (ADMIN ONLY) ----------
app.put("/api/admin/orders/:id", protect, isAdmin, async (req, res) => {
  try {
    const { status } = req.body; // "pending" | "active" | "delivered" | "cancelled"

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order nahi mila." });
    }

    res.json({ message: "Order status update ho gaya.", order });
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