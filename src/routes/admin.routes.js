import express from "express";
import { protect, restrictTo } from "../middleware/auth.js";
import { adminOverview } from "../controllers/admin.controller.js";

const router = express.Router();

router.get("/overview", protect, restrictTo("admin"), adminOverview);

export default router;
