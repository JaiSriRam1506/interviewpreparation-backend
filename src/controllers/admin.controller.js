import User from "../models/User.model.js";
import Session from "../models/Session.model.js";

export const adminOverview = async (req, res) => {
  const [users, sessions] = await Promise.all([
    User.countDocuments(),
    Session.countDocuments(),
  ]);

  res.status(200).json({
    status: "success",
    data: { users, sessions },
  });
};
