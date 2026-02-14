import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { protect } from "../middleware/auth.js";
import { getMe, updateMe } from "../controllers/user.controller.js";
import { selfUpgrade } from "../controllers/subscription.controller.js";

const router = express.Router();

const uploadDir = path.join(process.cwd(), "src", "uploads");
await fs.promises.mkdir(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-120);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get("/me", protect, getMe);
router.patch("/me", protect, upload.single("resume"), updateMe);
router.post("/upgrade", protect, selfUpgrade);

export default router;
