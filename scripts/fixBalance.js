/**
 * Script to recalculate and fix user balance based on actual transactions
 * This recalculates: total_deposit, available_balance, total_payout from payment_transactions
 */

import { supabase } from "../config/database.js";
import dotenv from "dotenv";

dotenv.config();

const userId = process.argv[2];

if (!userId) {
  console.error("Usage: node scripts/fixBalance.js <user_id>");
  process.exit(1);
}

async function fixBalance() {
  console.log(`\n🔧 Fixing balance for user: ${userId}\n`);

  try {
    // Get all transactions for this user
    const { data: transactions, error: txError } = await supabase
      .from("payment_transactions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "succeeded")
      .order("created_at", { ascending: true });

    if (txError) {
      throw new Error(`Failed to fetch transactions: ${txError.message}`);
    }

    if (!transactions || transactions.length === 0) {
      console.log("No transactions found for this user");
      return;
    }

    console.log(`Found ${transactions.length} successful transactions\n`);

    // Calculate totals from transactions
    let totalDeposit = 0;
    let totalPenalty = 0;
    let totalPayout = 0;

    transactions.forEach((tx) => {
      const amount = parseFloat(tx.amount);
      if (tx.type === "deposit") {
        totalDeposit += amount;
        console.log(`  ✅ Deposit: $${amount.toFixed(2)}`);
      } else if (tx.type === "penalty") {
        totalPenalty += amount;
        console.log(`  ❌ Penalty: $${amount.toFixed(2)}`);
      } else if (tx.type === "payout" || tx.type === "refund") {
        totalPayout += amount;
        console.log(`  💰 Payout: $${amount.toFixed(2)}`);
      }
    });

    const calculatedAvailableBalance =
      totalDeposit - totalPenalty - totalPayout;

    console.log("\n📊 Calculated Totals:");
    console.log(`   Total Deposits: $${totalDeposit.toFixed(2)}`);
    console.log(`   Total Penalties: $${totalPenalty.toFixed(2)}`);
    console.log(`   Total Payouts: $${totalPayout.toFixed(2)}`);
    console.log(
      `   Available Balance: $${calculatedAvailableBalance.toFixed(2)}`
    );

    // Get current balance from database
    const { data: currentBalance, error: balanceError } = await supabase
      .from("commitment_balances")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (balanceError && balanceError.code !== "PGRST116") {
      throw new Error(
        `Failed to fetch current balance: ${balanceError.message}`
      );
    }

    console.log("\n📋 Current Balance in Database:");
    if (currentBalance) {
      console.log(
        `   Total Deposit: $${parseFloat(
          currentBalance.total_deposit || 0
        ).toFixed(2)}`
      );
      console.log(
        `   Available Balance: $${parseFloat(
          currentBalance.available_balance || 0
        ).toFixed(2)}`
      );
      console.log(
        `   Pending Penalties: $${parseFloat(
          currentBalance.pending_penalties || 0
        ).toFixed(2)}`
      );
      console.log(
        `   Total Payout: $${parseFloat(
          currentBalance.total_payout || 0
        ).toFixed(2)}`
      );
    } else {
      console.log("   No balance record found - will create one");
    }

    // Check if balance needs fixing
    const currentAvailable = currentBalance
      ? parseFloat(currentBalance.available_balance || 0)
      : 0;
    const needsFix =
      Math.abs(currentAvailable - calculatedAvailableBalance) > 0.01;

    if (needsFix) {
      console.log("\n⚠️  Balance mismatch detected!");
      console.log(
        `   Current: $${currentAvailable.toFixed(
          2
        )} vs Calculated: $${calculatedAvailableBalance.toFixed(2)}`
      );
      console.log("\n🔧 Updating balance...");

      if (currentBalance) {
        // Update existing balance
        const { error: updateError } = await supabase
          .from("commitment_balances")
          .update({
            total_deposit: totalDeposit,
            available_balance: Math.max(0, calculatedAvailableBalance),
            total_payout: totalPayout,
            pending_penalties: 0, // Reset pending penalties since we're recalculating
          })
          .eq("user_id", userId);

        if (updateError) {
          throw new Error(`Failed to update balance: ${updateError.message}`);
        }
      } else {
        // Create new balance record
        const { error: insertError } = await supabase
          .from("commitment_balances")
          .insert({
            user_id: userId,
            total_deposit: totalDeposit,
            available_balance: Math.max(0, calculatedAvailableBalance),
            total_payout: totalPayout,
            pending_penalties: 0,
          });

        if (insertError) {
          throw new Error(`Failed to create balance: ${insertError.message}`);
        }
      }

      console.log("✅ Balance updated successfully!");
    } else {
      console.log("\n✅ Balance is correct - no fix needed");
    }

    // Show final balance
    const { data: finalBalance } = await supabase
      .from("commitment_balances")
      .select("*")
      .eq("user_id", userId)
      .single();

    console.log("\n📊 Final Balance:");
    console.log(
      `   Total Deposit: $${parseFloat(finalBalance.total_deposit || 0).toFixed(
        2
      )}`
    );
    console.log(
      `   Available Balance: $${parseFloat(
        finalBalance.available_balance || 0
      ).toFixed(2)}`
    );
    console.log(
      `   Total Payout: $${parseFloat(finalBalance.total_payout || 0).toFixed(
        2
      )}`
    );
    console.log(
      `   Pending Penalties: $${parseFloat(
        finalBalance.pending_penalties || 0
      ).toFixed(2)}`
    );
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  }
}

fixBalance();
