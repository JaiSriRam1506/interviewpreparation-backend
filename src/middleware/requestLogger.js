export default function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();

    res.on("finish", () => {
      const durationMs = Date.now() - start;
      logger.info("request", {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
    });

    next();
  };
}
