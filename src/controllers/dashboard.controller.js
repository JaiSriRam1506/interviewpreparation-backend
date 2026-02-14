import Session from "../models/Session.model.js";

export const getDashboard = async (req, res) => {
  const sessions = await Session.find({ user: req.user._id }).select(
    "analytics startedAt endedAt status"
  );

  const totalSessions = sessions.length;
  const scored = sessions
    .map((s) => s.analytics?.avgScore)
    .filter((v) => typeof v === "number" && Number.isFinite(v));

  const averageScore = scored.length
    ? scored.reduce((a, b) => a + b, 0) / scored.length
    : 0;

  const tokensUsed = sessions.reduce(
    (sum, s) => sum + (s.analytics?.totalTokens || 0),
    0
  );

  const totalTimeSeconds = sessions.reduce((sum, s) => {
    if (!s.startedAt) return sum;
    const end = s.endedAt ? new Date(s.endedAt) : new Date();
    const start = new Date(s.startedAt);
    const diff = Math.max(0, (end.getTime() - start.getTime()) / 1000);
    return sum + diff;
  }, 0);

  res.status(200).json({
    totalSessions,
    averageScore: Number(averageScore.toFixed(1)),
    tokensUsed,
    totalTime: Math.floor(totalTimeSeconds),
  });
};
