import AppError from "../utils/AppError.js";

export const selfUpgrade = async (req, res, next) => {
  try {
    return next(new AppError("Premium/billing is disabled", 404));
  } catch (err) {
    next(err);
  }
};
