import { supabase } from "../config/database.js";
import { stripe } from "../config/stripe.js";

/**
 * Check and sync latest workout data for a week before penalty calculation
 * This ensures we're working with the most recent data available
 * @param {string} userId - User ID
 * @param {string} goalId - Goal ID
 * @param {Date} weekStart - Start of week (Sunday)
 * @param {Date} weekEnd - End of week (Saturday)
 * @returns {Promise<{isFresh: boolean, latestLogDate: Date|null, hoursSinceLastLog: number|null}>}
 */
async function checkDataFreshness(userId, goalId, weekStart, weekEnd) {
  try {
    // Convert week start/end to UTC datetime
    const weekStartUTC = new Date(
      weekStart.toISOString().split("T")[0] + "T00:00:00.000Z"
    );
    const weekEndUTC = new Date(
      weekEnd.toISOString().split("T")[0] + "T23:59:59.999Z"
    );

    // Get the latest workout log for this week
    const { data: latestLog, error } = await supabase
      .from("workout_logs")
      .select("date, updated_at")
      .eq("user_id", userId)
      .eq("goal_id", goalId)
      .gte("date", weekStartUTC.toISOString())
      .lte("date", weekEndUTC.toISOString())
      .order("date", { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "not found" - that's okay, just means no logs yet
      console.warn(
        `Warning: Could not check data freshness for goal ${goalId}:`,
        error.message
      );
      return { isFresh: false, latestLogDate: null, hoursSinceLastLog: null };
    }

    if (!latestLog) {
      // No logs found for this week
      return { isFresh: false, latestLogDate: null, hoursSinceLastLog: null };
    }

    // Check how recent the latest log is
    const latestLogDate = new Date(latestLog.date || latestLog.updated_at);
    const now = new Date();
    const hoursSinceLastLog = (now - latestLogDate) / (1000 * 60 * 60);

    // Consider data "fresh" if it's within the last 2 hours
    // This accounts for workouts that might have happened recently
    const isFresh = hoursSinceLastLog <= 2;

    return {
      isFresh,
      latestLogDate,
      hoursSinceLastLog: Math.round(hoursSinceLastLog * 10) / 10,
    };
  } catch (error) {
    console.warn(
      `Error checking data freshness for goal ${goalId}:`,
      error.message
    );
    return { isFresh: false, latestLogDate: null, hoursSinceLastLog: null };
  }
}

/**
 * Weekly penalty calculation job
 * Before calculating penalties, checks data freshness to ensure latest workout data is included
 * Should be run via cron (e.g., every Sunday at 11 PM)
 * @param {Date} [referenceDate] - Optional date to use for week calculation. Defaults to current date.
 */
export async function calculateWeeklyPenalties(referenceDate = null) {
  const now = referenceDate || new Date();
  const isPreviousWeek = referenceDate !== null;
  console.log(
    `Starting weekly penalty calculation${
      isPreviousWeek ? " for previous week" : ""
    }...`
  );
  console.log(`Reference date: ${now.toISOString()}`);

  try {
    // Get all active goals
    const { data: activeGoals, error: goalsError } = await supabase
      .from("goals")
      .select("*")
      .eq("status", "active");

    if (goalsError) {
      throw new Error(`Failed to fetch goals: ${goalsError.message}`);
    }

    if (!activeGoals || activeGoals.length === 0) {
      console.log("No active goals found");
      return;
    }

    const currentWeekStart = getWeekStart(now);
    const currentWeekEnd = getWeekEnd(now);

    console.log(
      `📅 Week range: ${
        currentWeekStart.toISOString().split("T")[0]
      } (Sunday) to ${currentWeekEnd.toISOString().split("T")[0]} (Saturday)`
    );

    // Process goals sequentially to prevent race conditions on balance updates
    // This ensures each penalty deduction sees the updated balance from previous deductions
    for (const goal of activeGoals) {
      try {
        // Check if the week overlaps with the goal's date range
        const goalStart = new Date(goal.start_date);
        const goalEnd = new Date(goal.end_date);

        // Week overlaps with goal if: weekStart <= goalEnd AND weekEnd >= goalStart
        if (currentWeekStart > goalEnd || currentWeekEnd < goalStart) {
          continue; // Week does not overlap with goal period
        }

        // SYNC STEP: Check data freshness before calculating penalties
        console.log(`\n🔄 Checking data freshness for goal ${goal.id}...`);
        const dataFreshness = await checkDataFreshness(
          goal.user_id,
          goal.id,
          currentWeekStart,
          currentWeekEnd
        );

        if (!dataFreshness.latestLogDate) {
          console.log(
            `   ⚠️  No workout logs found for this week. Proceeding with calculation (will result in penalty if goal requires workouts).`
          );
        } else if (!dataFreshness.isFresh) {
          console.log(
            `   ⚠️  WARNING: Latest workout log is ${
              dataFreshness.hoursSinceLastLog
            } hours old (${dataFreshness.latestLogDate.toISOString()}).`
          );
          console.log(
            `   💡 Consider syncing HealthKit data from the iOS app to ensure latest workouts are included.`
          );
          console.log(
            `   📊 Proceeding with calculation using available data...`
          );
        } else {
          console.log(
            `   ✅ Data is fresh (latest log: ${dataFreshness.latestLogDate.toISOString()}, ${
              dataFreshness.hoursSinceLastLog
            } hours ago)`
          );
        }

        // Check if penalty already calculated for this week
        const { data: existingPenalty } = await supabase
          .from("penalty_records")
          .select("id")
          .eq("goal_id", goal.id)
          .eq("week_start_date", currentWeekStart.toISOString().split("T")[0])
          .single();

        if (existingPenalty) {
          console.log(
            `Penalty already calculated for goal ${goal.id} this week`
          );
          continue;
        }

        // Get workout logs for this week
        // Convert week start/end to UTC datetime (start of day)
        const weekStartUTC = new Date(
          currentWeekStart.toISOString().split("T")[0] + "T00:00:00.000Z"
        );
        const weekEndUTC = new Date(
          currentWeekEnd.toISOString().split("T")[0] + "T23:59:59.999Z"
        );

        const { data: logs, error: logsError } = await supabase
          .from("workout_logs")
          .select("*")
          .eq("user_id", goal.user_id)
          .eq("goal_id", goal.id)
          .gte("date", weekStartUTC.toISOString())
          .lte("date", weekEndUTC.toISOString())
          .order("date", { ascending: true });

        if (logsError) {
          console.error(`Error fetching logs for goal ${goal.id}:`, logsError);
          continue;
        }

        // Aggregate logs by date (sum durations for same day)
        // Date is now a datetime, so we extract the date part for grouping
        const aggregatedByDate = {};
        (logs || []).forEach((log) => {
          const logDate = new Date(log.date);
          const dateKey = logDate.toISOString().split("T")[0]; // Extract YYYY-MM-DD
          if (!aggregatedByDate[dateKey]) {
            aggregatedByDate[dateKey] = 0;
          }
          aggregatedByDate[dateKey] += log.duration_minutes;
        });

        // Calculate completed days (days where aggregated total meets minimum)
        const completedDays = Object.values(aggregatedByDate).filter(
          (totalMinutes) => totalMinutes >= goal.min_duration_minutes
        ).length;

        const requiredDays = goal.frequency_per_week;
        const failedDays = Math.max(0, requiredDays - completedDays);
        const penaltyPerDay = parseFloat(goal.stake_amount) / requiredDays;
        const penaltyAmount = failedDays * penaltyPerDay;

        // Only create penalty record if there's an actual penalty (amount > 0)
        if (penaltyAmount > 0) {
          // Create penalty record
          const { data: penaltyRecord, error: penaltyError } = await supabase
            .from("penalty_records")
            .insert({
              goal_id: goal.id,
              week_start_date: currentWeekStart.toISOString().split("T")[0],
              week_end_date: currentWeekEnd.toISOString().split("T")[0],
              required_days: requiredDays,
              completed_days: completedDays,
              failed_days: failedDays,
              penalty_amount: penaltyAmount,
              paid: false,
            })
            .select()
            .single();

          if (penaltyError) {
            console.error(
              `Error creating penalty record for goal ${goal.id}:`,
              penaltyError
            );
            continue;
          }

          // Deduct penalty from balance
          // Process penalties sequentially to avoid race conditions
          await deductPenalty(
            goal.user_id,
            penaltyAmount,
            goal.id,
            penaltyRecord.id
          );

          console.log(
            `Goal ${
              goal.id
            }: ${completedDays}/${requiredDays} days completed. Penalty: $${penaltyAmount.toFixed(
              2
            )}`
          );
        } else {
          // No penalty - goal was met, don't create a record
          console.log(
            `Goal ${goal.id}: ${completedDays}/${requiredDays} days completed. No penalty - goal met!`
          );
        }
      } catch (error) {
        console.error(`Error processing goal ${goal.id}:`, error);
        continue;
      }
    }

    console.log("Weekly penalty calculation completed");
  } catch (error) {
    console.error("Penalty calculation job error:", error);
    throw error;
  }
}

/**
 * Deduct penalty from user balance
 */
async function deductPenalty(userId, amount, goalId, penaltyRecordId) {
  try {
    // Get current balance
    const { data: balance, error: balanceError } = await supabase
      .from("commitment_balances")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (balanceError || !balance) {
      console.error(`Balance not found for user ${userId}`);
      throw new Error(
        `Balance record does not exist for user ${userId}. Deposits must be made before penalties can be calculated.`
      );
    }

    const availableBalance = parseFloat(balance.available_balance) || 0;

    if (availableBalance >= amount) {
      // CRITICAL FIX: Use atomic update with current balance check to prevent race conditions
      // This ensures we're subtracting from the actual current balance, not a stale value
      const newAvailableBalance = availableBalance - amount;
      const newPendingPenalties = Math.max(
        0,
        (parseFloat(balance.pending_penalties) || 0) - amount
      );

      // Update balance atomically - this prevents race conditions when multiple penalties are processed
      const { data: updatedBalance, error: updateError } = await supabase
        .from("commitment_balances")
        .update({
          available_balance: newAvailableBalance,
          pending_penalties: newPendingPenalties,
        })
        .eq("user_id", userId)
        .eq("available_balance", availableBalance) // Optimistic locking: only update if balance hasn't changed
        .select()
        .single();

      if (updateError) {
        // If update failed due to optimistic lock (balance changed), retry once with fresh balance
        if (
          updateError.code === "PGRST116" ||
          updateError.message.includes("No rows")
        ) {
          console.warn(
            `Balance changed during penalty deduction for user ${userId}, retrying...`
          );
          // Get fresh balance and retry
          const { data: freshBalance } = await supabase
            .from("commitment_balances")
            .select("*")
            .eq("user_id", userId)
            .single();

          if (freshBalance) {
            const freshAvailableBalance =
              parseFloat(freshBalance.available_balance) || 0;
            if (freshAvailableBalance >= amount) {
              const retryNewBalance = freshAvailableBalance - amount;
              const retryNewPending = Math.max(
                0,
                (parseFloat(freshBalance.pending_penalties) || 0) - amount
              );

              const { error: retryError } = await supabase
                .from("commitment_balances")
                .update({
                  available_balance: retryNewBalance,
                  pending_penalties: retryNewPending,
                })
                .eq("user_id", userId);

              if (retryError) {
                console.error(
                  `Error updating balance on retry for user ${userId}:`,
                  retryError.message
                );
                throw retryError;
              }
            } else {
              // Balance insufficient after retry, fall through to insufficient balance handling
              console.warn(
                `Insufficient balance after retry for user ${userId}. Available: $${freshAvailableBalance}, Required: $${amount}`
              );
            }
          } else {
            throw new Error(
              `Balance record not found on retry for user ${userId}`
            );
          }
        } else {
          console.error(
            `Error updating balance for user ${userId}:`,
            updateError.message
          );
          throw updateError;
        }
      } else if (!updatedBalance) {
        // Update succeeded but no data returned - verify with a fresh read
        const { data: verifyBalance } = await supabase
          .from("commitment_balances")
          .select("*")
          .eq("user_id", userId)
          .single();

        if (!verifyBalance) {
          throw new Error(`Failed to verify balance update for user ${userId}`);
        }
      }

      // Mark penalty as paid
      await supabase
        .from("penalty_records")
        .update({ paid: true })
        .eq("id", penaltyRecordId);

      // Get user currency
      const { data: userData } = await supabase
        .from("users")
        .select("currency")
        .eq("id", userId)
        .single();
      const currency = userData?.currency || "usd";

      // Record transaction
      await supabase.from("payment_transactions").insert({
        user_id: userId,
        amount,
        currency: currency,
        status: "succeeded",
        type: "penalty",
        goal_id: goalId,
        metadata: {
          penalty_record_id: penaltyRecordId,
          source: "balance_deduction",
        },
      });

      console.log(`Deducted $${amount.toFixed(2)} from user ${userId} balance`);
    } else {
      // Insufficient balance - mark as pending
      await supabase
        .from("commitment_balances")
        .update({
          pending_penalties:
            (parseFloat(balance.pending_penalties) || 0) + amount,
        })
        .eq("user_id", userId);

      // Get user's Stripe customer ID, default payment method, and currency
      const { data: user } = await supabase
        .from("users")
        .select("stripe_customer_id, default_payment_method_id, currency")
        .eq("id", userId)
        .single();

      if (user?.stripe_customer_id && user?.default_payment_method_id) {
        // Attempt to charge the saved payment method
        const currency = user.currency || "usd";
        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: currency,
            customer: user.stripe_customer_id,
            payment_method: user.default_payment_method_id,
            metadata: {
              user_id: userId,
              type: "penalty",
              goal_id: goalId,
              penalty_record_id: penaltyRecordId,
            },
            off_session: true,
            confirm: true,
          });

          if (paymentIntent.status === "succeeded") {
            await supabase
              .from("penalty_records")
              .update({ paid: true })
              .eq("id", penaltyRecordId);

            await supabase.from("payment_transactions").insert({
              user_id: userId,
              stripe_payment_intent_id: paymentIntent.id,
              stripe_customer_id: user.stripe_customer_id,
              amount,
              currency: currency,
              status: "succeeded",
              type: "penalty",
              goal_id: goalId,
              metadata: {
                penalty_record_id: penaltyRecordId,
                source: "stripe_charge",
              },
            });

            console.log(
              `Charged $${amount.toFixed(2)} to user ${userId} for penalty`
            );
          }
        } catch (stripeError) {
          console.error(
            `Failed to charge user ${userId} for penalty:`,
            stripeError.message
          );
          // Penalty remains unpaid, will be retried or handled manually
        }
      }
    }
  } catch (error) {
    console.error(`Error deducting penalty for user ${userId}:`, error);
  }
}

/**
 * Get start of current week (Sunday) in UTC
 * @param {Date} date - Date to calculate week start from
 * @returns {Date} Start of week (Sunday 00:00:00 UTC)
 */
export function getWeekStart(date) {
  const d = new Date(date);
  // Use UTC methods to avoid timezone issues
  // If day is 0 (Sunday), we want that day. Otherwise, go back to previous Sunday
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
  const daysToSubtract = day === 0 ? 0 : day;
  const weekStart = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - daysToSubtract,
      0,
      0,
      0,
      0
    )
  );
  return weekStart;
}

/**
 * Get end of current week (Saturday) in UTC
 * @param {Date} date - Date to calculate week end from
 * @returns {Date} End of week (Saturday 23:59:59.999 UTC)
 */
export function getWeekEnd(date) {
  const weekStart = getWeekStart(date);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);
  return weekEnd;
}
