import express from "express";
import { protect } from "../middleware/auth.js";
import { scrapeJobPost } from "../controllers/scrape.controller.js";

const router = express.Router();

router.post("/job", protect, scrapeJobPost);

export default router;
