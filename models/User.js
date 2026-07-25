const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true }, // bcrypt se hash hoga
    phone: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);