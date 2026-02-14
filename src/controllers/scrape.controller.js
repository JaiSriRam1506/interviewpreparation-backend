import axios from "axios";
import AppError from "../utils/AppError.js";

const stripTags = (html) => html.replace(/<[^>]*>/g, " ");

export const scrapeJobPost = async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return next(new AppError("URL is required", 400));

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    });

    const html = String(response.data || "");
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || "";

    const description = stripTags(html)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);

    // Very light heuristics
    const company = title.split("-")[0]?.trim() || "";

    res.status(200).json({
      status: "success",
      company,
      title: title || "Job Post",
      description,
      url,
      scraped: true,
    });
  } catch (err) {
    next(err);
  }
};
