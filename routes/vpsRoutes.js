const express = require("express");
const Order = require("../models/Order");
const protect = require("../middleware/auth");

const router = express.Router();

// ---------- VPS PLANS (static list - koi bhi dekh sakta hai, login ki zarurat nahi) ----------
const plans = [
  { id: 1, name: "Starter VPS", ram: "2GB RAM", cpu: "1 vCPU", storage: "40GB SSD", bandwidth: "1TB", price: 299 },
  { id: 2, name: "Business VPS", ram: "4GB RAM", cpu: "2 vCPU", storage: "80GB SSD", bandwidth: "2TB", price: 599 },
  { id: 3, name: "Pro VPS", ram: "8GB RAM", cpu: "4 vCPU", storage: "160GB SSD", bandwidth: "4TB", price: 1199 },
  { id: 4, name: "Enterprise VPS", ram: "16GB RAM", cpu: "8 vCPU", storage: "320GB SSD", bandwidth: "8TB", price: 2399 },
];

router.get("/plans", (req, res) => {
  res.json(plans);
});

// ---------- BUY / ORDER (LOGIN REQUIRED - protect middleware yaha lagta hai) ----------
router.post("/order", protect, async (req, res) => {
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

// ---------- Apne orders dekhne ke liye (LOGIN REQUIRED) ----------
router.get("/my-orders", protect, async (req, res) => {
  const orders = await Order.find({ user: req.userId }).sort({ createdAt: -1 });
  res.json(orders);
});

module.exports = router;