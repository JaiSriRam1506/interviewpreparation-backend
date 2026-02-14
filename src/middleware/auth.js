import jwt from "jsonwebtoken";
import User from "../models/User.model.js";
import AppError from "../utils/AppError.js";

const getBearerToken = (req) => {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];
  return null;
};

export const protect = async (req, res, next) => {
  try {
    const token = getBearerToken(req);
    if (!token) return next(new AppError("Not authenticated", 401));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return next(new AppError("User no longer exists", 401));
    if (!user.isActive) return next(new AppError("Account deactivated", 403));
    if (user.changedPasswordAfter(decoded.iat)) {
      return next(new AppError("Password changed. Please log in again.", 401));
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return next(new AppError("Not authenticated", 401));
    if (!roles.includes(req.user.role)) {
      return next(new AppError("Forbidden", 403));
    }
    next();
  };
};
