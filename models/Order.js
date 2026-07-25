const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    planName: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: "pending" }, // pending, active, cancelled
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);