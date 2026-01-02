import dotenv from "dotenv";
import {
  calculateWeeklyPenalties,
  getWeekStart,
  getWeekEnd,
} from "../jobs/penaltyCalculator.js";
import { supabase } from "../config/database.js";

// Load environment variables
dotenv.config();

/**
 * Test script for penalty calculation
 *
 * Usage:
 *   node scripts/testPenaltyCalculation.js
 *   node scripts/testPenaltyCalculation.js 2024-01-15
 *   node scripts/testPenaltyCalculation.js "2024-01-15T10:30:00Z"
 *
 * This script will:
 * 1. Show current state (goals, workout logs, existing penalties)
 * 2. Run the penalty calculation function
 * 3. Show results (new penalty records, updated balances)
 */

async function testPenaltyCalculation() {
  // Parse custom date from command line arguments
  let referenceDate = new Date();
  if (process.argv[2]) {
    const customDate = new Date(process.argv[2]);
    if (isNaN(customDate.getTime())) {
      console.error(
        `❌ Invalid date format: ${process.argv[2]}\n` +
          `   Expected formats: YYYY-MM-DD or ISO8601 datetime\n` +
          `   Example: 2024-01-15 or "2024-01-15T10:30:00Z"`
      );
      process.exit(1);
    }
    referenceDate = customDate;
  }

  console.log("\n🧪 ════════════════════════════════════════════════════");
  console.log("🧪 PENALTY CALCULATION TEST");
  console.log("🧪 ════════════════════════════════════════════════════\n");

  try {
    const currentWeekStart = getWeekStart(referenceDate);
    const currentWeekEnd = getWeekEnd(referenceDate);

    console.log("📅 Reference Date:", referenceDate.toISOString());
    console.log("📅 Week Range:");
    console.log(
      `   Start: ${currentWeekStart.toISOString().split("T")[0]} (Sunday)`
    );
    console.log(
      `   End: ${currentWeekEnd.toISOString().split("T")[0]} (Saturday)`
    );
    console.log();

    // Show state BEFORE calculation
    console.log("\n📋 ════════════════════════════════════════════════════");
    console.log("📋 STATE BEFORE CALCULATION");
    console.log("📋 ════════════════════════════════════════════════════\n");

    // Get all active goals
    const { data: activeGoals, error: goalsError } = await supabase
      .from("goals")
      .select("*")
      .eq("status", "active");

    if (goalsError) {
      throw new Error(`Failed to fetch goals: ${goalsError.message}`);
    }

    if (!activeGoals || activeGoals.length === 0) {
      console.log("❌ No active goals found");
      return;
    }

    console.log(`✅ Found ${activeGoals.length} active goal(s)\n`);

    // Show goals and their workout logs
    for (const goal of activeGoals) {
      console.log(`\n╔═══════════════════════════════════════════════════╗`);
      console.log(`║ Goal ID: ${goal.id}`);
      console.log("╠═══════════════════════════════════════════════════╣");
      console.log(`   User ID: ${goal.user_id}`);
      console.log(`   Frequency: ${goal.frequency_per_week} days/week`);
      console.log(`   Min Duration: ${goal.min_duration_minutes} minutes`);
      console.log(`   Stake Amount: $${goal.stake_amount}/week`);
      console.log(
        `   Goal Period: ${
          new Date(goal.start_date).toISOString().split("T")[0]
        } to ${new Date(goal.end_date).toISOString().split("T")[0]}`
      );

      // Check if the week overlaps with the goal's date range
      const goalStart = new Date(goal.start_date);
      const goalEnd = new Date(goal.end_date);

      // Week overlaps with goal if: weekStart <= goalEnd AND weekEnd >= goalStart
      if (currentWeekStart > goalEnd || currentWeekEnd < goalStart) {
        console.log(
          `   ⚠️  Week does not overlap with goal period (week: ${
            currentWeekStart.toISOString().split("T")[0]
          } to ${currentWeekEnd.toISOString().split("T")[0]}, goal: ${
            goalStart.toISOString().split("T")[0]
          } to ${goalEnd.toISOString().split("T")[0]})`
        );
        console.log("╚═══════════════════════════════════════════════════╝");
        continue;
      }

      // Check existing penalty
      const { data: existingPenalty } = await supabase
        .from("penalty_records")
        .select("*")
        .eq("goal_id", goal.id)
        .eq("week_start_date", currentWeekStart.toISOString().split("T")[0])
        .single();

      if (existingPenalty) {
        console.log(`\n   ⚠️  Penalty already calculated for this week`);
        console.log(`   Penalty Record:`);
        console.log(
          `      Completed Days: ${existingPenalty.completed_days}/${existingPenalty.required_days}`
        );
        console.log(`      Failed Days: ${existingPenalty.failed_days}`);
        console.log(`      Penalty Amount: $${existingPenalty.penalty_amount}`);
        console.log(`      Paid: ${existingPenalty.paid ? "Yes" : "No"}`);
      }

      // Get workout logs for this week
      const weekStartUTC = new Date(
        currentWeekStart.toISOString().split("T")[0] + "T00:00:00.000Z"
      );
      const weekEndUTC = new Date(
        currentWeekEnd.toISOString().split("T")[0] + "T23:59:59.999Z"
      );

      const { data: logs } = await supabase
        .from("workout_logs")
        .select("*")
        .eq("user_id", goal.user_id)
        .eq("goal_id", goal.id)
        .gte("date", weekStartUTC.toISOString())
        .lte("date", weekEndUTC.toISOString())
        .order("date", { ascending: true });

      console.log(
        `\n   📊 Workout Logs: ${logs?.length || 0} log(s) for this week`
      );
      if (logs && logs.length > 0) {
        logs.forEach((log, index) => {
          const logDate = new Date(log.date);
          console.log(
            `      ${index + 1}. ${logDate.toISOString().split("T")[0]} - ${
              log.duration_minutes
            } minutes`
          );
        });
      }

      // Get user balance
      const { data: balance } = await supabase
        .from("commitment_balances")
        .select("*")
        .eq("user_id", goal.user_id)
        .single();

      if (balance) {
        console.log(`\n   💳 User Balance:`);
        console.log(`      Available: $${balance.available_balance || 0}`);
        console.log(
          `      Pending Penalties: $${balance.pending_penalties || 0}`
        );
      }

      console.log("╚═══════════════════════════════════════════════════╝");
    }

    // Run the actual penalty calculation
    console.log("\n\n🚀 ════════════════════════════════════════════════════");
    console.log("🚀 RUNNING PENALTY CALCULATION");
    console.log("🚀 ════════════════════════════════════════════════════\n");
    await calculateWeeklyPenalties(referenceDate);

    // Show state AFTER calculation
    console.log("\n\n📊 ════════════════════════════════════════════════════");
    console.log("📊 STATE AFTER CALCULATION");
    console.log("📊 ════════════════════════════════════════════════════\n");

    // Show updated penalty records
    for (const goal of activeGoals) {
      const goalStart = new Date(goal.start_date);
      const goalEnd = new Date(goal.end_date);

      // Check if the week overlaps with the goal's date range
      if (currentWeekStart > goalEnd || currentWeekEnd < goalStart) {
        continue;
      }

      const { data: penaltyRecord } = await supabase
        .from("penalty_records")
        .select("*")
        .eq("goal_id", goal.id)
        .eq("week_start_date", currentWeekStart.toISOString().split("T")[0])
        .single();

      if (penaltyRecord) {
        console.log(`\n╔═══════════════════════════════════════════════════╗`);
        console.log(`║ Goal ID: ${goal.id} - Penalty Record`);
        console.log("╠═══════════════════════════════════════════════════╣");
        console.log(
          `   Completed Days: ${penaltyRecord.completed_days}/${penaltyRecord.required_days}`
        );
        console.log(`   Failed Days: ${penaltyRecord.failed_days}`);
        console.log(`   Penalty Amount: $${penaltyRecord.penalty_amount}`);
        console.log(`   Paid: ${penaltyRecord.paid ? "Yes" : "No"}`);

        // Get updated balance
        const { data: balance } = await supabase
          .from("commitment_balances")
          .select("*")
          .eq("user_id", goal.user_id)
          .single();

        if (balance) {
          console.log(`\n   💳 Updated Balance:`);
          console.log(`      Available: $${balance.available_balance || 0}`);
          console.log(
            `      Pending Penalties: $${balance.pending_penalties || 0}`
          );
        }

        console.log("╚═══════════════════════════════════════════════════╝");
      }
    }

    console.log("\n✅ Test completed!\n");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
testPenaltyCalculation()
  .then(() => {
    console.log("Test script finished");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test script error:", error);
    process.exit(1);
  });
