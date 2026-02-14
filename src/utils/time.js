const unitToSeconds = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
};

export const parseExpiryToSeconds = (value, defaultSeconds) => {
  if (!value) return defaultSeconds;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return defaultSeconds;

  const trimmed = value.trim();
  if (!trimmed) return defaultSeconds;

  // If someone sets seconds directly: "604800"
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // Supports JWT-style: 15m, 7d, 2h
  const match = trimmed.match(/^(\d+)\s*([smhd])$/i);
  if (!match) return defaultSeconds;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * (unitToSeconds[unit] || 1);
};
