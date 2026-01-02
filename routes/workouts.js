import express from "express";
import { supabase } from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router();

// Debug flag - set to true to enable verbose logging
const DEBUG_LOGGING_ENABLED = process.env.DEBUG_LOGGING === "true" || false;

// Submit workout log (from iOS app)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { date, duration_minutes, healthkit_id, goal_id } = req.body;

    if (!date || duration_minutes === undefined) {
      return res
        .status(400)
        .json({ error: "Date (datetime) and duration_minutes required" });
    }

    // Parse datetime - should come as ISO8601 datetime string (latest workout end time)
    const dateTime = new Date(date);
    if (isNaN(dateTime.getTime())) {
      return res
        .status(400)
        .json({ error: "Invalid date format. Expected ISO8601 datetime." });
    }

    // Convert to UTC ISO8601 string for storage
    const dateTimeISO = dateTime.toISOString();

    // Extract just the date part for comparison (YYYY-MM-DD)
    // We need to find existing logs for the same day, regardless of the exact time
    const dateOnly = dateTime.toISOString().split("T")[0];
    const startOfDayUTC = new Date(dateOnly + "T00:00:00.000Z");
    const nextDayStartUTC = new Date(
      startOfDayUTC.getTime() + 24 * 60 * 60 * 1000
    );

    // Check if log already exists for this user, date (same calendar day), and goal
    // For aggregated totals, we check by user_id, date (within same day), and goal_id
    const { data: existingLog } = await supabase
      .from("workout_logs")
      .select("id, duration_minutes, healthkit_id, date")
      .eq("user_id", req.user.id)
      .eq("goal_id", goal_id || null)
      .gte("date", startOfDayUTC.toISOString())
      .lt("date", nextDayStartUTC.toISOString())
      .single();

    if (existingLog) {
      // Update existing log by adding to the total duration
      // Use the latest end time (current datetime if it's later than existing)
      const existingDate = new Date(existingLog.date);
      const latestEndTime =
        dateTime > existingDate ? dateTimeISO : existingLog.date;

      const newTotalDuration = existingLog.duration_minutes + duration_minutes;
      const updatedHealthkitId = existingLog.healthkit_id
        ? `${existingLog.healthkit_id},${healthkit_id || ""}`.replace(
            /^,|,$/g,
            ""
          )
        : healthkit_id || null;

      const { data: log, error } = await supabase
        .from("workout_logs")
        .update({
          date: latestEndTime, // Update to latest workout end time
          duration_minutes: newTotalDuration,
          healthkit_id: updatedHealthkitId,
          verified: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingLog.id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.json({ log });
    }

    // Create new log with datetime (latest workout end time in UTC)
    const { data: log, error } = await supabase
      .from("workout_logs")
      .insert({
        user_id: req.user.id,
        goal_id: goal_id || null,
        date: dateTimeISO, // Store as latest workout end time UTC datetime
        duration_minutes,
        healthkit_id: healthkit_id || null,
        source: "apple_health",
        verified: true,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ log });
  } catch (error) {
    console.error("Submit workout error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get workout logs for user
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date, goal_id } = req.query;

    let query = supabase
      .from("workout_logs")
      .select("*")
      .eq("user_id", req.user.id)
      .order("date", { ascending: false });

    if (start_date) {
      // If start_date is just a date (YYYY-MM-DD), convert to start of day UTC
      // If it's already a datetime, use it as is
      const startDate = start_date.includes("T")
        ? new Date(start_date).toISOString()
        : new Date(start_date + "T00:00:00.000Z").toISOString();
      query = query.gte("date", startDate);
    }

    if (end_date) {
      // If end_date is just a date (YYYY-MM-DD), convert to end of day UTC
      // If it's already a datetime, use it as is
      const endDate = end_date.includes("T")
        ? new Date(end_date).toISOString()
        : new Date(end_date + "T23:59:59.999Z").toISOString();
      query = query.lte("date", endDate);
    }

    if (goal_id) {
      query = query.eq("goal_id", goal_id);
    }

    const { data: logs, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ logs: logs || [] });
  } catch (error) {
    console.error("Get workouts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Batch submit workout logs
router.post("/batch", authenticateToken, async (req, res) => {
  try {
    const { logs } = req.body;

    if (DEBUG_LOGGING_ENABLED) {
      console.log("\n📥 ════════════════════════════════════════════════════");
      console.log("📥 RECEIVED BATCH WORKOUT LOGS REQUEST");
      console.log("📥 ════════════════════════════════════════════════════");
      console.log("   User ID:", req.user.id);
      console.log("   User Email:", req.user.email);
      console.log("   Total logs received:", logs?.length || 0);
      console.log("\n   Full Request Body:");
      console.log(JSON.stringify(req.body, null, 2));
    }

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: "Logs array required" });
    }

    if (DEBUG_LOGGING_ENABLED) {
      // Log all received logs with complete details
      console.log("\n   ════════════════════════════════════════════════════");
      console.log("   RECEIVED LOGS - COMPLETE DATA:");
      console.log("   ════════════════════════════════════════════════════");
      logs.forEach((log, index) => {
        console.log(`\n   Log #${index + 1} - Complete Details:`);
        console.log("      Raw log object:", JSON.stringify(log, null, 6));
        console.log("      date:", log.date);
        console.log("      duration_minutes:", log.duration_minutes);
        console.log(
          "      duration_minutes type:",
          typeof log.duration_minutes
        );
        console.log("      healthkit_id:", log.healthkit_id || "nil");
        console.log("      goal_id:", log.goal_id || "nil");
        console.log("      All keys:", Object.keys(log));
      });

      // Validate and prepare logs
      console.log("\n   ════════════════════════════════════════════════════");
      console.log("   VALIDATING AND PREPARING LOGS:");
      console.log("   ════════════════════════════════════════════════════");
    }

    // Aggregate logs by date (sum durations for same day and goal)
    // This ensures we store daily totals instead of individual workouts
    const aggregatedLogs = {};

    logs.forEach((log) => {
      if (!log.date || log.duration_minutes === undefined) {
        if (DEBUG_LOGGING_ENABLED) {
          console.log(`   ❌ Invalid log filtered out:`, log);
        }
        return;
      }

      // Parse the datetime - it should be the latest workout end time for that day
      const logDate = new Date(log.date);
      if (isNaN(logDate.getTime())) {
        if (DEBUG_LOGGING_ENABLED) {
          console.log(`   ❌ Invalid date format in log:`, log);
        }
        return;
      }

      // Extract date part for grouping (YYYY-MM-DD)
      const dateOnly = logDate.toISOString().split("T")[0];

      // Create a key for date + goal_id combination
      const key = `${dateOnly}_${log.goal_id || "no_goal"}`;

      if (!aggregatedLogs[key]) {
        aggregatedLogs[key] = {
          user_id: req.user.id,
          goal_id: log.goal_id || null,
          date: log.date, // Store the actual datetime (latest workout end time)
          duration_minutes: 0,
          healthkit_id: log.healthkit_id || null,
          source: "apple_health",
          verified: true,
        };
      } else {
        // Update to use the latest end time if this log has a later time
        const existingDate = new Date(aggregatedLogs[key].date);
        if (logDate > existingDate) {
          aggregatedLogs[key].date = log.date; // Update to latest end time
        }
      }

      // Sum up the durations
      aggregatedLogs[key].duration_minutes += log.duration_minutes;

      // Combine healthkit_ids if multiple workouts on same day
      if (log.healthkit_id) {
        if (aggregatedLogs[key].healthkit_id) {
          aggregatedLogs[key].healthkit_id += `,${log.healthkit_id}`;
        } else {
          aggregatedLogs[key].healthkit_id = log.healthkit_id;
        }
      }
    });

    const validLogs = Object.values(aggregatedLogs).map((prepared) => {
      if (DEBUG_LOGGING_ENABLED) {
        console.log(
          "   ✅ Prepared aggregated log:",
          JSON.stringify(prepared, null, 6)
        );
      }
      return prepared;
    });

    if (DEBUG_LOGGING_ENABLED) {
      console.log("\n   Valid logs after filtering:", validLogs.length);
      console.log("   ════════════════════════════════════════════════════");
    }

    if (validLogs.length === 0) {
      return res.status(400).json({ error: "No valid logs provided" });
    }

    if (DEBUG_LOGGING_ENABLED) {
      console.log("\n   ════════════════════════════════════════════════════");
      console.log("   DATABASE OPERATION:");
      console.log("   ════════════════════════════════════════════════════");
      console.log(
        "   Upserting logs with conflict resolution on: user_id, date, healthkit_id"
      );
      console.log("   Valid logs to upsert:", validLogs.length);
    }

    // For aggregated logs, we want to update by user_id, date, and goal_id
    // This ensures one record per day per goal with the total duration
    const { data: insertedLogs, error } = await supabase
      .from("workout_logs")
      .upsert(validLogs, {
        onConflict: "user_id,date,goal_id",
        ignoreDuplicates: false,
      })
      .select();

    if (error) {
      // Always log errors, but add more detail if debug is enabled
      console.error("Database error:", error.message);
      if (DEBUG_LOGGING_ENABLED) {
        console.error(
          "\n   ❌ ════════════════════════════════════════════════════"
        );
        console.error("   ❌ DATABASE ERROR:");
        console.error(
          "   ❌ ════════════════════════════════════════════════════"
        );
        console.error("   Error message:", error.message);
        console.error("   Error details:", error);
        console.error("   Error code:", error.code);
        console.error("   Error hint:", error.hint);
        console.error(
          "   ════════════════════════════════════════════════════"
        );
      }
      return res.status(500).json({ error: error.message });
    }

    const response = { logs: insertedLogs, count: insertedLogs.length };

    if (DEBUG_LOGGING_ENABLED) {
      console.log(
        "\n   ✅ ════════════════════════════════════════════════════"
      );
      console.log("   ✅ DATABASE OPERATION SUCCESSFUL");
      console.log("   ✅ ════════════════════════════════════════════════════");
      console.log(
        "   Successfully inserted/updated workout logs:",
        insertedLogs.length
      );
      console.log("\n   SAVED LOGS - COMPLETE DATA:");
      console.log("   ════════════════════════════════════════════════════");
      insertedLogs.forEach((log, index) => {
        console.log(`\n   Saved Log #${index + 1} - Complete Details:`);
        console.log("      Full object:", JSON.stringify(log, null, 6));
        console.log("      id:", log.id);
        console.log("      user_id:", log.user_id);
        console.log("      goal_id:", log.goal_id || "nil");
        console.log("      date:", log.date);
        console.log("      duration_minutes:", log.duration_minutes);
        console.log("      healthkit_id:", log.healthkit_id || "nil");
        console.log("      source:", log.source);
        console.log("      verified:", log.verified);
        console.log("      created_at:", log.created_at);
        console.log("      updated_at:", log.updated_at);
      });

      console.log("\n   ════════════════════════════════════════════════════");
      console.log("   RESPONSE BEING SENT:");
      console.log("   ════════════════════════════════════════════════════");
      console.log(JSON.stringify(response, null, 2));
      console.log("   ════════════════════════════════════════════════════\n");
    }

    res.json(response);
  } catch (error) {
    console.error("Batch submit error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
