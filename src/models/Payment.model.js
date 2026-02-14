// src/models/Payment.model.js
import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Stripe Details
    stripePaymentId: {
      type: String,
      required: true,
      unique: true,
    },
    stripeCustomerId: String,
    stripeSubscriptionId: String,

    // Payment Details
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "usd",
      enum: ["usd", "inr", "eur", "gbp"],
    },
    description: String,

    // Plan Details
    plan: {
      type: String,
      enum: ["basic", "premium", "enterprise"],
      required: true,
    },
    interval: {
      type: String,
      enum: ["month", "year"],
      default: "month",
    },

    // Status
    status: {
      type: String,
      enum: ["pending", "processing", "succeeded", "failed", "refunded"],
      default: "pending",
    },

    // Metadata
    metadata: mongoose.Schema.Types.Mixed,

    // Billing Details
    billingDetails: {
      email: String,
      name: String,
      phone: String,
      address: {
        line1: String,
        line2: String,
        city: String,
        state: String,
        postal_code: String,
        country: String,
      },
    },

    // Webhook Data
    webhookEvents: [
      {
        type: {
          type: String,
          enum: [
            "payment_intent.created",
            "payment_intent.succeeded",
            "payment_intent.failed",
            "invoice.paid",
            "invoice.payment_failed",
          ],
        },
        data: mongoose.Schema.Types.Mixed,
        receivedAt: Date,
      },
    ],

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
paymentSchema.index({ user: 1, status: 1 });
paymentSchema.index({ stripePaymentId: 1 });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ "metadata.sessionId": 1 });

// Methods
paymentSchema.methods.isSuccessful = function () {
  return this.status === "succeeded";
};

paymentSchema.methods.getAmountWithCurrency = function () {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: this.currency.toUpperCase(),
  });
  return formatter.format(this.amount / 100); // Convert from cents
};

export default mongoose.model("Payment", paymentSchema);
