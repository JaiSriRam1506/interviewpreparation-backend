import AppError from "../utils/AppError.js";

const isDuplicateKeyError = (err) => err?.code === 11000;

const handleMongooseValidation = (err) => {
  const details = Object.values(err.errors || {}).map((e) => ({
    path: e.path,
    message: e.message,
  }));
  return new AppError("Validation failed", 400, details);
};

const handleDuplicateKey = (err) => {
  const keys = err.keyValue ? Object.keys(err.keyValue) : [];
  const message = keys.length
    ? `Duplicate value for: ${keys.join(", ")}`
    : "Duplicate key";
  return new AppError(message, 409);
};

const handleJWTError = () => new AppError("Invalid token. Please log in.", 401);
const handleJWTExpired = () =>
  new AppError("Token expired. Please refresh or log in.", 401);

export default function errorHandler(err, req, res, next) {
  const env = process.env.NODE_ENV || "development";

  let error = err;

  if (error?.name === "ValidationError")
    error = handleMongooseValidation(error);
  if (isDuplicateKeyError(error)) error = handleDuplicateKey(error);
  if (error?.name === "JsonWebTokenError") error = handleJWTError();
  if (error?.name === "TokenExpiredError") error = handleJWTExpired();

  if (!(error instanceof AppError)) {
    error = new AppError(error?.message || "Internal server error", 500);
  }

  if (env === "development") {
    return res.status(error.statusCode).json({
      status: error.status,
      message: error.message,
      details: error.details,
      stack: err?.stack,
    });
  }

  // Production: don't leak internals
  return res.status(error.statusCode).json({
    status: error.status,
    message: error.isOperational ? error.message : "Something went wrong",
    details: error.details,
  });
}
