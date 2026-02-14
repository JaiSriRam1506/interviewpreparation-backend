// src/middleware/validation.js
import Joi from "joi";

export const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join("."),
        message: detail.message,
      }));

      return res.status(400).json({
        status: "error",
        message: "Validation failed",
        errors,
      });
    }

    next();
  };
};

// Schemas
export const authSchemas = {
  register: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(100).required(),
    name: Joi.string().min(2).max(50).required(),
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  resetPassword: Joi.object({
    password: Joi.string().min(8).max(100).required(),
    confirmPassword: Joi.string().valid(Joi.ref("password")).required(),
  }),
};
