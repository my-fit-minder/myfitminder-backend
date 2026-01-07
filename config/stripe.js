import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

// Support both test and live modes
// Use STRIPE_MODE environment variable to switch: 'test' or 'live'
// Default to 'test' if not specified
const stripeMode = process.env.STRIPE_MODE || "test";

// Get the appropriate secret key based on mode
const secretKey =
  stripeMode === "live"
    ? process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET_KEY
    : process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY;

// Get the appropriate publishable key based on mode
export const publishableKey =
  stripeMode === "live"
    ? process.env.STRIPE_LIVE_PUBLISHABLE_KEY ||
      process.env.STRIPE_PUBLISHABLE_KEY
    : process.env.STRIPE_TEST_PUBLISHABLE_KEY ||
      process.env.STRIPE_PUBLISHABLE_KEY;

if (!secretKey) {
  throw new Error(
    `Missing STRIPE_${stripeMode.toUpperCase()}_SECRET_KEY or STRIPE_SECRET_KEY environment variable`
  );
}

if (!publishableKey) {
  console.warn(
    `⚠️  STRIPE_${stripeMode.toUpperCase()}_PUBLISHABLE_KEY not set. Publishable key endpoint will not work.`
  );
}

export const stripe = new Stripe(secretKey);
export const isLiveMode = stripeMode === "live";
