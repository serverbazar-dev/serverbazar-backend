const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const vpsRoutes = require("./routes/vpsRoutes");

dotenv.config();
connectDB();

const app = express();

app.use(cors()); // production me isme apna frontend URL daal dena, e.g. cors({ origin: process.env.CLIENT_URL })
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/vps", vpsRoutes);

app.get("/", (req, res) => {
  res.send("ServerBazar API chal raha hai 🚀");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server chal raha hai port ${PORT} par`));