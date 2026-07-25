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
  } catch (err) {
    console.error("MongoDB connection error ❌", err.message);
    process.exit(1);
  }
};
connectDB();

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    phone: { type: String },
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

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      phone,
    });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      message: "Account ban gaya!",
      token,
      user: { id: user._id, name: user.name, email: user.email },
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

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      message: "Login successful!",
      token,
      user: { id: user._id, name: user.name, email: user.email },
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

// ==================== BASE ROUTE ====================
app.get("/", (req, res) => {
  res.send("ServerBazar API chal raha hai 🚀");
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server chal raha hai port ${PORT} par`));