import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let hasLoggedError = false;

export const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: () => false,
  },
});

redisClient.on("error", (err) => {
  // eslint-disable-next-line no-console
  if (!hasLoggedError) {
    hasLoggedError = true;
    console.warn(
      "Redis not available; continuing without Redis (refresh tokens will use Mongo fallback)."
    );
    // eslint-disable-next-line no-console
    console.warn(String(err?.message || err));
  }
});

let connected = false;

export const isRedisReady = () => connected && redisClient.isReady;

export const connectRedis = async () => {
  if (connected) return;
  try {
    await redisClient.connect();
    connected = true;
  } catch (err) {
    connected = false;
    hasLoggedError = true;
  }
};
