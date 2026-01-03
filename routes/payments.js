import express from "express";
import { supabase } from "../config/database.js";
import { stripe } from "../config/stripe.js";
import { authenticateToken } from "../middleware/auth.js";
import {
  getWeekStart,
  chargePendingPenalties,
} from "../jobs/penaltyCalculator.js";

const router = express.Router();

// Helper function to get or create Stripe customer
async function getOrCreateStripeCustomer(user) {
  let stripeCustomerId = user.stripe_customer_id;

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: {
        user_id: user.id,
      },
    });

    stripeCustomerId = customer.id;

    // Update user with Stripe customer ID
    await supabase
      .from("users")
      .update({ stripe_customer_id: stripeCustomerId })
      .eq("id", user.id);
  }

  return stripeCustomerId;
}

// Create SetupIntent for adding payment method
router.post("/setup-intent", authenticateToken, async (req, res) => {
  try {
    const stripeCustomerId = await getOrCreateStripeCustomer(req.user);

    // Create SetupIntent for saving a card
    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ["card"],
      metadata: {
        user_id: req.user.id,
      },
    });

    res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    });
  } catch (error) {
    console.error("Create setup intent error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Confirm SetupIntent and save payment method
router.post("/confirm-setup", authenticateToken, async (req, res) => {
  try {
    const { setupIntentId } = req.body;

    if (!setupIntentId) {
      return res.status(400).json({ error: "SetupIntent ID required" });
    }

    // Retrieve SetupIntent from Stripe
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

    if (setupIntent.status !== "succeeded") {
      return res.status(400).json({ error: "SetupIntent not succeeded" });
    }

    // Set as default payment method
    const paymentMethodId = setupIntent.payment_method;

    await supabase
      .from("users")
      .update({ default_payment_method_id: paymentMethodId })
      .eq("id", req.user.id);

    // Get payment method details
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

    // Attempt to charge any pending penalties now that payment method is added
    await chargePendingPenalties(req.user.id);

    res.json({
      success: true,
      paymentMethod: {
        id: paymentMethod.id,
        brand: paymentMethod.card?.brand,
        last4: paymentMethod.card?.last4,
        expMonth: paymentMethod.card?.exp_month,
        expYear: paymentMethod.card?.exp_year,
      },
    });
  } catch (error) {
    console.error("Confirm setup error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Get saved payment methods
router.get("/payment-methods", authenticateToken, async (req, res) => {
  try {
    if (!req.user.stripe_customer_id) {
      return res.json({ paymentMethods: [], defaultPaymentMethodId: null });
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: req.user.stripe_customer_id,
      type: "card",
    });

    const formattedMethods = paymentMethods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand,
      last4: pm.card?.last4,
      expMonth: pm.card?.exp_month,
      expYear: pm.card?.exp_year,
    }));

    res.json({
      paymentMethods: formattedMethods,
      defaultPaymentMethodId: req.user.default_payment_method_id,
    });
  } catch (error) {
    console.error("Get payment methods error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Set default payment method
router.post(
  "/set-default-payment-method",
  authenticateToken,
  async (req, res) => {
    try {
      const { paymentMethodId } = req.body;

      if (!paymentMethodId) {
        return res.status(400).json({ error: "Payment method ID required" });
      }

      // Verify payment method belongs to customer
      const paymentMethod = await stripe.paymentMethods.retrieve(
        paymentMethodId
      );

      if (paymentMethod.customer !== req.user.stripe_customer_id) {
        return res
          .status(403)
          .json({ error: "Payment method does not belong to user" });
      }

      await supabase
        .from("users")
        .update({ default_payment_method_id: paymentMethodId })
        .eq("id", req.user.id);

      // Attempt to charge any pending penalties now that default payment method is set
      await chargePendingPenalties(req.user.id);

      res.json({ success: true });
    } catch (error) {
      console.error("Set default payment method error:", error);
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  }
);

// Remove payment method
router.delete("/payment-methods/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify payment method belongs to customer
    const paymentMethod = await stripe.paymentMethods.retrieve(id);

    if (paymentMethod.customer !== req.user.stripe_customer_id) {
      return res
        .status(403)
        .json({ error: "Payment method does not belong to user" });
    }

    // Detach payment method
    await stripe.paymentMethods.detach(id);

    // If this was the default, clear it
    if (req.user.default_payment_method_id === id) {
      await supabase
        .from("users")
        .update({ default_payment_method_id: null })
        .eq("id", req.user.id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Remove payment method error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Charge penalty to saved payment method
router.post("/charge-penalty", authenticateToken, async (req, res) => {
  try {
    const { amount, goalId, penaltyRecordId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount required" });
    }

    if (!req.user.default_payment_method_id) {
      return res.status(400).json({ error: "No payment method on file" });
    }

    if (!req.user.stripe_customer_id) {
      return res.status(400).json({ error: "No Stripe customer" });
    }

    // Get user currency (default to 'usd' if not set)
    const currency = req.user.currency || "usd";

    // Create PaymentIntent and confirm immediately with saved card
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency,
      customer: req.user.stripe_customer_id,
      payment_method: req.user.default_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: {
        user_id: req.user.id,
        type: "penalty",
        goal_id: goalId,
        penalty_record_id: penaltyRecordId,
      },
    });

    // Record transaction
    await supabase.from("payment_transactions").insert({
      user_id: req.user.id,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_customer_id: req.user.stripe_customer_id,
      amount,
      currency: currency,
      status: paymentIntent.status === "succeeded" ? "succeeded" : "pending",
      type: "penalty",
      goal_id: goalId,
      metadata: { penalty_record_id: penaltyRecordId },
    });

    // Update penalty record as paid
    if (penaltyRecordId && paymentIntent.status === "succeeded") {
      await supabase
        .from("penalty_records")
        .update({ paid: true })
        .eq("id", penaltyRecordId);
    }

    res.json({
      success: paymentIntent.status === "succeeded",
      paymentIntent: {
        id: paymentIntent.id,
        status: paymentIntent.status,
      },
    });
  } catch (error) {
    console.error("Charge penalty error:", error);

    // Handle card declined or requires authentication
    if (error.code === "authentication_required") {
      return res.status(402).json({
        error: "Card requires authentication",
        requiresAction: true,
      });
    }

    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Create deposit payment intent (charges saved card if available)
router.post("/deposit", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount required" });
    }

    const stripeCustomerId = await getOrCreateStripeCustomer(req.user);
    const currency = req.user.currency || "usd";

    // If user has a saved payment method, charge it directly
    if (req.user.default_payment_method_id) {
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: currency,
          customer: stripeCustomerId,
          payment_method: req.user.default_payment_method_id,
          off_session: true,
          confirm: true,
          metadata: {
            user_id: req.user.id,
            type: "deposit",
          },
        });

        // Record transaction
        await supabase.from("payment_transactions").insert({
          user_id: req.user.id,
          stripe_payment_intent_id: paymentIntent.id,
          stripe_customer_id: stripeCustomerId,
          amount,
          currency: currency,
          status:
            paymentIntent.status === "succeeded" ? "succeeded" : "pending",
          type: "deposit",
        });

        // Update balance if succeeded
        if (paymentIntent.status === "succeeded") {
          const { data: balance } = await supabase
            .from("commitment_balances")
            .select("*")
            .eq("user_id", req.user.id)
            .single();

          if (balance) {
            await supabase
              .from("commitment_balances")
              .update({
                total_deposit:
                  (parseFloat(balance.total_deposit) || 0) + amount,
                available_balance:
                  (parseFloat(balance.available_balance) || 0) + amount,
              })
              .eq("user_id", req.user.id);
          } else {
            await supabase.from("commitment_balances").insert({
              user_id: req.user.id,
              total_deposit: amount,
              available_balance: amount,
              pending_penalties: 0,
            });
          }
        }

        // If payment requires authentication, return client secret for PaymentSheet
        if (
          paymentIntent.status === "requires_action" &&
          paymentIntent.next_action
        ) {
          return res.json({
            success: false,
            charged: false,
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            status: paymentIntent.status,
            requiresAction: true,
          });
        }

        return res.json({
          success: paymentIntent.status === "succeeded",
          charged: paymentIntent.status === "succeeded",
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        });
      } catch (stripeError) {
        // If card requires authentication, create a PaymentIntent that requires action
        if (
          stripeError.code === "authentication_required" ||
          stripeError.payment_intent
        ) {
          const paymentIntent =
            stripeError.payment_intent ||
            (await stripe.paymentIntents.retrieve(
              stripeError.payment_intent.id
            ));

          return res.json({
            success: false,
            charged: false,
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            status: paymentIntent.status,
            requiresAction: true,
          });
        }

        // If card declined or other error, fall through to show PaymentSheet
        console.error("Error charging saved card:", stripeError);
        // Fall through to create new PaymentIntent
      }
    }

    // No saved payment method - create PaymentIntent for PaymentSheet
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      customer: stripeCustomerId,
      payment_method_types: ["card"],
      setup_future_usage: "off_session", // Save card for future use
      metadata: {
        user_id: req.user.id,
        type: "deposit",
      },
    });

    // Record transaction
    await supabase.from("payment_transactions").insert({
      user_id: req.user.id,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_customer_id: stripeCustomerId,
      amount,
      currency: currency,
      status: "pending",
      type: "deposit",
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      charged: false,
    });
  } catch (error) {
    console.error("Create deposit error:", error);

    // Handle card declined
    if (error.code === "card_declined") {
      return res.status(402).json({ error: "Card was declined" });
    }
    if (error.code === "authentication_required") {
      return res.status(402).json({
        error: "Card requires authentication",
        requiresAction: true,
      });
    }

    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Confirm payment and update balance
router.post("/confirm", authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "PaymentIntent ID required" });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ error: "Payment not succeeded" });
    }

    // Update transaction status
    await supabase
      .from("payment_transactions")
      .update({ status: "succeeded" })
      .eq("stripe_payment_intent_id", paymentIntentId);

    // If it's a deposit, update balance
    if (paymentIntent.metadata.type === "deposit") {
      const amount = paymentIntent.amount / 100;

      // Get current balance
      const { data: balance } = await supabase
        .from("commitment_balances")
        .select("*")
        .eq("user_id", req.user.id)
        .single();

      if (balance) {
        // Update balance
        await supabase
          .from("commitment_balances")
          .update({
            total_deposit: (parseFloat(balance.total_deposit) || 0) + amount,
            available_balance:
              (parseFloat(balance.available_balance) || 0) + amount,
          })
          .eq("user_id", req.user.id);
      } else {
        // Create balance record
        await supabase.from("commitment_balances").insert({
          user_id: req.user.id,
          total_deposit: amount,
          available_balance: amount,
          pending_penalties: 0,
        });
      }
    }

    res.json({ success: true, paymentIntent });
  } catch (error) {
    console.error("Confirm payment error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Get payment transactions
router.get("/transactions", authenticateToken, async (req, res) => {
  try {
    const { data: transactions, error } = await supabase
      .from("payment_transactions")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Log transaction types for debugging
    if (transactions && transactions.length > 0) {
      const typeCounts = {};
      transactions.forEach((tx) => {
        typeCounts[tx.type] = (typeCounts[tx.type] || 0) + 1;
      });
      console.log("Transaction types:", typeCounts);
    }

    res.json({ transactions: transactions || [] });
  } catch (error) {
    console.error("Get transactions error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Request payout of wallet balance (sends money back to original payment methods via Stripe refunds)
router.post("/request-payout", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount required" });
    }

    // Minimum payout amount
    if (amount < 1) {
      return res.status(400).json({
        error: "Minimum payout amount is $1.00",
      });
    }

    // Get current balance
    const { data: balance, error: balanceError } = await supabase
      .from("commitment_balances")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (balanceError || !balance) {
      return res.status(404).json({ error: "Balance not found" });
    }

    const availableBalance = parseFloat(balance.available_balance) || 0;

    // Calculate locked amount from active goals
    // Only lock the current week's stake_amount for active goals (until penalties are calculated)
    let lockedAmount = 0;

    // Get all active goals for the user
    const { data: activeGoals, error: goalsError } = await supabase
      .from("goals")
      .select("id, stake_amount, start_date, end_date")
      .eq("user_id", req.user.id)
      .eq("status", "active");

    if (goalsError) {
      console.error("Error fetching active goals:", goalsError);
      return res.status(500).json({
        error: "Error calculating locked funds. Please try again.",
      });
    }

    if (activeGoals && activeGoals.length > 0) {
      // Check if current week's penalties have been calculated
      const now = new Date();
      const currentWeekStart = getWeekStart(now);
      const currentWeekStartDate = currentWeekStart.toISOString().split("T")[0]; // YYYY-MM-DD

      // For each active goal that overlaps with the current week, check if penalties are calculated
      for (const goal of activeGoals) {
        const goalStart = new Date(goal.start_date);
        const goalEnd = new Date(goal.end_date);
        const currentWeekEnd = new Date(currentWeekStart);
        currentWeekEnd.setUTCDate(currentWeekEnd.getUTCDate() + 6);
        currentWeekEnd.setUTCHours(23, 59, 59, 999);

        // Check if current week overlaps with goal period
        // Week overlaps if: weekStart <= goalEnd AND weekEnd >= goalStart
        if (currentWeekStart <= goalEnd && currentWeekEnd >= goalStart) {
          // Check if penalty has been calculated for this week
          const { data: penaltyRecord } = await supabase
            .from("penalty_records")
            .select("id")
            .eq("goal_id", goal.id)
            .eq("week_start_date", currentWeekStartDate)
            .single();

          // If no penalty record exists, the current week's stake_amount is locked
          if (!penaltyRecord) {
            const stakeAmount = parseFloat(goal.stake_amount) || 0;
            lockedAmount += stakeAmount;
          }
        }
      }
    }

    // Calculate truly available balance (available balance minus locked funds)
    const trulyAvailableBalance = Math.max(0, availableBalance - lockedAmount);

    if (amount > trulyAvailableBalance) {
      const lockedMessage =
        lockedAmount > 0
          ? ` This includes $${lockedAmount.toFixed(
              2
            )} locked for the current week (until penalties are calculated).`
          : "";
      return res.status(400).json({
        error: `Payout amount exceeds available balance. Maximum payoutable: $${trulyAvailableBalance.toFixed(
          2
        )}.${lockedMessage}`,
      });
    }

    // Get user's successful deposit transactions (any deposits, regardless of payment method)
    const { data: deposits, error: depositsError } = await supabase
      .from("payment_transactions")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("type", "deposit")
      .eq("status", "succeeded")
      .order("created_at", { ascending: false })
      .limit(50);

    if (depositsError) {
      console.error("Error fetching deposits:", depositsError);
      return res.status(500).json({
        error: "Error fetching deposit transactions. Please try again.",
      });
    }

    if (!deposits || deposits.length === 0) {
      return res.status(404).json({
        error:
          "No deposit transactions found. Cannot process payout without original payment information.",
      });
    }

    console.log(
      `Found ${deposits.length} deposit transactions for user ${req.user.id}`
    );

    // Find deposits with payment intents (these can be used for payouts via Stripe refunds)
    const depositsWithIntents = deposits.filter(
      (d) => d.stripe_payment_intent_id
    );

    console.log(
      `Found ${depositsWithIntents.length} deposits with payment intent IDs`
    );

    if (depositsWithIntents.length === 0) {
      // Log which deposits don't have payment intent IDs
      const depositsWithoutIntents = deposits.filter(
        (d) => !d.stripe_payment_intent_id
      );
      console.log(
        `${depositsWithoutIntents.length} deposits without payment intent IDs`
      );

      return res.status(404).json({
        error:
          "No deposits found that can be used for payout. Your deposits don't have associated payment intents. This may indicate a data sync issue. Please contact support.",
      });
    }

    // Get all payment intents that can be used for payout (regardless of which payment method was used)
    // Note: We use Stripe's refund API to process payouts, which sends money back to the original payment method
    // Funds will be returned to whatever card was originally charged
    const payoutableIntents = [];
    const errors = [];

    for (const deposit of depositsWithIntents) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          deposit.stripe_payment_intent_id
        );

        console.log(`Payment Intent ${deposit.stripe_payment_intent_id}:`, {
          amount: paymentIntent.amount,
          amount_refunded: paymentIntent.amount_refunded,
          status: paymentIntent.status,
        });

        // Handle undefined/null amount_refunded (means no payouts have been made yet)
        // Stripe may not include this field if no refunds exist
        const amountRefunded = paymentIntent.amount_refunded || 0;
        const payoutableAmount = paymentIntent.amount - amountRefunded;

        if (payoutableAmount > 0) {
          payoutableIntents.push({
            paymentIntentId: deposit.stripe_payment_intent_id,
            payoutableAmount: payoutableAmount / 100, // Convert to dollars
            originalAmount: paymentIntent.amount / 100,
            depositAmount: parseFloat(deposit.amount),
            paymentMethodId: paymentIntent.payment_method,
          });
          console.log(
            `Payment Intent ${deposit.stripe_payment_intent_id}: $${(
              payoutableAmount / 100
            ).toFixed(2)} available for payout (original: $${(
              paymentIntent.amount / 100
            ).toFixed(2)}, already refunded: $${(amountRefunded / 100).toFixed(
              2
            )})`
          );
        } else {
          console.log(
            `Payment Intent ${
              deposit.stripe_payment_intent_id
            }: No payoutable amount (original: $${(
              paymentIntent.amount / 100
            ).toFixed(2)}, already refunded: $${(amountRefunded / 100).toFixed(
              2
            )})`
          );
        }
      } catch (error) {
        const errorMsg = `Error checking payment intent ${deposit.stripe_payment_intent_id}: ${error.message}`;
        console.error(errorMsg);
        errors.push(errorMsg);
        continue;
      }
    }

    console.log(
      `Found ${payoutableIntents.length} payment intents available for payout`
    );

    if (payoutableIntents.length === 0) {
      let errorMessage = "No payoutable amount available from your deposits.";

      if (errors.length > 0) {
        errorMessage +=
          " Some payment intents could not be retrieved from Stripe.";
        console.error("Errors retrieving payment intents:", errors);
      } else if (depositsWithIntents.length > 0) {
        errorMessage += " All deposits may have already been paid out.";
      }

      return res.status(400).json({
        error: errorMessage,
      });
    }

    // Calculate total payoutable amount from all deposits
    const totalPayoutable = payoutableIntents.reduce(
      (sum, intent) => sum + intent.payoutableAmount,
      0
    );

    // Use the minimum of available balance and total payoutable
    const maxPayoutable = Math.min(availableBalance, totalPayoutable);

    if (amount > maxPayoutable) {
      return res.status(400).json({
        error: `Payout amount exceeds available balance. Maximum payoutable: $${maxPayoutable.toFixed(
          2
        )}`,
      });
    }

    // Calculate fees
    // Stripe fee: 2.9% + $0.30
    const stripeFeeRate = 0.029; // 2.9%
    const stripeFixedFee = 0.3; // $0.30
    const stripeFee = amount * stripeFeeRate + stripeFixedFee;

    // Currency conversion fee: 1% (charged by card issuer for non-USD cards)
    // Note: We assume all users may have non-USD cards, so we apply this fee
    // In practice, you might want to check the user's card currency
    const conversionFeeRate = 0.01; // 1%
    const conversionFee = amount * conversionFeeRate;

    // Total fees
    const totalFees = stripeFee + conversionFee;

    // Net amount after fees
    const netAmount = amount - totalFees;

    // Ensure net amount is positive
    if (netAmount <= 0) {
      return res.status(400).json({
        error: `Payout amount is too small. After fees (${(
          (totalFees / amount) *
          100
        ).toFixed(2)}%), the net amount would be $${netAmount.toFixed(
          2
        )}. Minimum payout after fees must be at least $0.01.`,
      });
    }

    // Process payout via Stripe refunds (sends money back to original payment methods)
    // Note: Stripe refunds can only go back to the original payment method used for each deposit
    // Funds will be returned to the cards that were originally charged
    // Start with the most recent deposits
    // We process the full requested amount, but fees are deducted from the user's balance
    let remainingAmount = amount;
    const payouts = [];

    for (const intent of payoutableIntents) {
      if (remainingAmount <= 0) break;

      const payoutFromThisIntent = Math.min(
        remainingAmount,
        intent.payoutableAmount
      );

      try {
        // Use Stripe's refund API to process the payout
        const refund = await stripe.refunds.create({
          payment_intent: intent.paymentIntentId,
          amount: Math.round(payoutFromThisIntent * 100), // Convert to cents
          metadata: {
            user_id: req.user.id,
            type: "wallet_payout",
          },
        });

        payouts.push({
          refund,
          amount: payoutFromThisIntent,
        });

        remainingAmount -= payoutFromThisIntent;
      } catch (error) {
        console.error(
          `Error processing payout for ${intent.paymentIntentId}:`,
          error
        );
        // If this specific intent fails, try the next one
        continue;
      }
    }

    if (payouts.length === 0) {
      return res.status(500).json({
        error: "Failed to process payout. Please try again or contact support.",
      });
    }

    // Calculate total paid out amount (needed for fee calculations)
    const totalPaidOut = payouts.reduce((sum, p) => sum + p.amount, 0);

    // Record all payout transactions
    for (const { refund, amount: payoutAmount } of payouts) {
      // Map Stripe refund status to payout status
      // Try payout-specific statuses first, fallback to generic if constraint not updated
      let payoutStatus;
      if (refund.status === "succeeded") {
        payoutStatus = "payout_succeeded";
      } else if (refund.status === "pending") {
        payoutStatus = "payout_requested";
      } else {
        payoutStatus = "payout_failed";
      }

      const currency = req.user.currency || "usd";
      // Calculate fees for this specific payout
      // Proportionally distribute the fixed fee across all payouts
      const payoutStripeFee =
        payoutAmount * stripeFeeRate +
        stripeFixedFee * (payoutAmount / totalPaidOut);
      const payoutConversionFee = payoutAmount * conversionFeeRate;
      const payoutTotalFees = payoutStripeFee + payoutConversionFee;
      const payoutNetAmount = payoutAmount - payoutTotalFees;

      const transactionData = {
        user_id: req.user.id,
        stripe_payment_intent_id: refund.id,
        amount: payoutAmount,
        currency: currency,
        status: payoutStatus,
        type: "payout",
        metadata: {
          payout_type: "wallet_payout",
          original_payment_intent: refund.payment_intent,
          fees: {
            stripe_fee: payoutStripeFee,
            conversion_fee: payoutConversionFee,
            total: payoutTotalFees,
          },
          net_amount: payoutNetAmount,
        },
      };

      console.log(`Attempting to insert payout transaction:`, {
        user_id: req.user.id,
        amount: payoutAmount,
        status: payoutStatus,
        type: "payout",
        refund_id: refund.id,
      });

      // Try inserting with payout status first
      let insertResult = await supabase
        .from("payment_transactions")
        .insert(transactionData)
        .select();

      // If insert failed (likely due to constraint), try with generic status
      if (insertResult.error) {
        console.warn(
          `Failed to insert payout with status ${payoutStatus}:`,
          insertResult.error.message,
          insertResult.error
        );

        // Fallback to generic status if constraint not updated
        const fallbackStatus =
          refund.status === "succeeded" ? "succeeded" : "pending";

        const fallbackData = {
          ...transactionData,
          status: fallbackStatus,
        };

        console.log(`Retrying with fallback status: ${fallbackStatus}`);
        insertResult = await supabase
          .from("payment_transactions")
          .insert(fallbackData)
          .select();

        if (insertResult.error) {
          console.error(
            "Failed to insert payout transaction with fallback status:",
            insertResult.error.message,
            insertResult.error,
            JSON.stringify(insertResult.error, null, 2)
          );
          // Log the full error details
          if (insertResult.error.details) {
            console.error("Error details:", insertResult.error.details);
          }
          if (insertResult.error.hint) {
            console.error("Error hint:", insertResult.error.hint);
          }
        } else {
          console.log(
            `Successfully inserted payout transaction with fallback status:`,
            insertResult.data
          );
          if (!insertResult.data || insertResult.data.length === 0) {
            console.warn("Insert returned success but no data was returned!");
          }
        }
      } else {
        console.log(
          `Successfully inserted payout transaction:`,
          insertResult.data
        );
        if (!insertResult.data || insertResult.data.length === 0) {
          console.warn("Insert returned success but no data was returned!");
        }
      }
    }

    // Log summary of payout transaction inserts
    console.log(
      `Completed payout transaction recording. Processed ${payouts.length} payouts.`
    );

    // totalPaidOut is already calculated above
    const allSucceeded = payouts.every((p) => p.refund.status === "succeeded");

    // Calculate fees for the actual payout amount
    const actualStripeFee = totalPaidOut * stripeFeeRate + stripeFixedFee;
    const actualConversionFee = totalPaidOut * conversionFeeRate;
    const actualTotalFees = actualStripeFee + actualConversionFee;
    const actualNetAmount = totalPaidOut - actualTotalFees;

    // Update balance immediately (deduct full amount including fees from available balance and add net payout to total payout)
    await supabase
      .from("commitment_balances")
      .update({
        available_balance: Math.max(0, availableBalance - totalPaidOut), // Deduct full amount (fees included)
        total_payout: (parseFloat(balance.total_payout) || 0) + actualNetAmount, // Add net amount after fees
      })
      .eq("user_id", req.user.id);

    res.json({
      success: allSucceeded,
      payout: {
        id: payouts[0].refund.id,
        amount: totalPaidOut,
        netAmount: actualNetAmount,
        fees: {
          stripeFee: actualStripeFee,
          conversionFee: actualConversionFee,
          total: actualTotalFees,
        },
        status: allSucceeded ? "succeeded" : "pending",
        message: allSucceeded
          ? `Payout of $${totalPaidOut.toFixed(
              2
            )} processed successfully! After fees ($${actualTotalFees.toFixed(
              2
            )}), you will receive $${actualNetAmount.toFixed(
              2
            )}. Funds will be returned to the original payment methods used for deposits within 5-10 business days.`
          : `Payout of $${totalPaidOut.toFixed(
              2
            )} is being processed. After fees ($${actualTotalFees.toFixed(
              2
            )}), you will receive $${actualNetAmount.toFixed(
              2
            )}. Funds will be returned to the original payment methods used for deposits.`,
      },
    });
  } catch (error) {
    console.error("Request payout error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Process refund
router.post("/refund", authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId, amount } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "PaymentIntent ID required" });
    }

    // Get transaction
    const { data: transaction } = await supabase
      .from("payment_transactions")
      .select("*")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .eq("user_id", req.user.id)
      .single();

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Create refund in Stripe
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amount ? Math.round(amount * 100) : undefined, // Partial refund if amount specified
      metadata: {
        user_id: req.user.id,
        original_transaction_id: transaction.id,
      },
    });

    // Record refund transaction
    const currency = req.user.currency || "usd";
    await supabase.from("payment_transactions").insert({
      user_id: req.user.id,
      stripe_payment_intent_id: refund.id,
      amount: refund.amount / 100,
      currency: currency,
      status: refund.status === "succeeded" ? "succeeded" : "pending",
      type: "refund",
      metadata: {
        original_payment_intent: paymentIntentId,
      },
    });

    // Update balance if refund succeeded
    if (refund.status === "succeeded") {
      const refundAmount = refund.amount / 100;
      const { data: balance } = await supabase
        .from("commitment_balances")
        .select("*")
        .eq("user_id", req.user.id)
        .single();

      if (balance) {
        await supabase
          .from("commitment_balances")
          .update({
            available_balance: Math.max(
              0,
              (parseFloat(balance.available_balance) || 0) - refundAmount
            ),
          })
          .eq("user_id", req.user.id);
      }
    }

    res.json({ refund });
  } catch (error) {
    console.error("Refund error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Stripe webhook handler
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object;
        // Update transaction status
        await supabase
          .from("payment_transactions")
          .update({ status: "succeeded" })
          .eq("stripe_payment_intent_id", paymentIntent.id);

        // If deposit, update balance
        if (paymentIntent.metadata.type === "deposit") {
          const userId = paymentIntent.metadata.user_id;
          const amount = paymentIntent.amount / 100;

          const { data: balance } = await supabase
            .from("commitment_balances")
            .select("*")
            .eq("user_id", userId)
            .single();

          if (balance) {
            await supabase
              .from("commitment_balances")
              .update({
                total_deposit:
                  (parseFloat(balance.total_deposit) || 0) + amount,
                available_balance:
                  (parseFloat(balance.available_balance) || 0) + amount,
              })
              .eq("user_id", userId);
          } else {
            await supabase.from("commitment_balances").insert({
              user_id: userId,
              total_deposit: amount,
              available_balance: amount,
              pending_penalties: 0,
            });
          }
        }
        break;

      case "payment_intent.payment_failed":
        const failedPayment = event.data.object;
        await supabase
          .from("payment_transactions")
          .update({ status: "failed" })
          .eq("stripe_payment_intent_id", failedPayment.id);
        break;

      case "setup_intent.succeeded":
        const setupIntent = event.data.object;
        // Set as default payment method for user
        if (setupIntent.metadata.user_id && setupIntent.payment_method) {
          await supabase
            .from("users")
            .update({ default_payment_method_id: setupIntent.payment_method })
            .eq("id", setupIntent.metadata.user_id);
        }
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

export default router;
