import express from "express";
import cron from "node-cron";
import { start as runSyncScript } from "./toonstream-supabase-sync.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Track sync status
let syncStatus = {
  isRunning: false,
  lastRunTime: null,
  lastRunSuccess: null,
  totalRuns: 0,
  successfulRuns: 0,
  failedRuns: 0,
  nextRunTime: null,
};

// Health check endpoint for Render
app.get("/", (req, res) => {
  res.json({
    status: "alive",
    service: "Toonstream Supabase Sync",
    uptime: process.uptime(),
    syncStatus,
    timestamp: new Date().toISOString(),
  });
});

// Manual trigger endpoint
app.get("/sync", async (req, res) => {
  if (syncStatus.isRunning) {
    return res.json({
      status: "already_running",
      message: "Sync is already in progress",
      syncStatus,
    });
  }

  res.json({
    status: "triggered",
    message: "Sync started manually",
  });

  // Run sync in background
  runSync();
});

// Status endpoint
app.get("/status", (req, res) => {
  res.json({
    syncStatus,
    proxyEnabled: process.env.USE_PROXY === "true",
    pollInterval: process.env.POLL_INTERVAL_MS || "60000",
    timestamp: new Date().toISOString(),
  });
});

async function runSync() {
  if (syncStatus.isRunning) {
    console.log("⏭️  Sync already running, skipping...");
    return;
  }

  syncStatus.isRunning = true;
  syncStatus.lastRunTime = new Date().toISOString();
  syncStatus.totalRuns++;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Starting sync run #${syncStatus.totalRuns}`);
  console.log(`⏰ Time: ${syncStatus.lastRunTime}`);
  console.log(`${"=".repeat(60)}\n`);

  try {
    // Run the sync script directly
    await runSyncScript();

    syncStatus.lastRunSuccess = true;
    syncStatus.successfulRuns++;
    console.log("\n✅ Sync completed successfully\n");
  } catch (error) {
    syncStatus.lastRunSuccess = false;
    syncStatus.failedRuns++;
    console.error(`\n❌ Sync failed: ${error.message}\n`);
    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    syncStatus.isRunning = false;
  }
}

// Schedule sync every 1 minute
const cronExpression = process.env.CRON_SCHEDULE || "*/1 * * * *"; // Every 1 minute
cron.schedule(cronExpression, () => {
  console.log("\n⏰ Scheduled sync triggered");
  runSync();
});

// Calculate next run time
function updateNextRunTime() {
  const now = new Date();
  const next = new Date(now.getTime() + 60000); // Add 1 minute
  syncStatus.nextRunTime = next.toISOString();
}

// Update next run time every minute
setInterval(updateNextRunTime, 60000);
updateNextRunTime();

// Start server
app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Toonstream Sync Server Started`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`⏰ Sync schedule: Every 1 minute`);
  console.log(`🔐 Proxy enabled: ${process.env.USE_PROXY === "true" ? "Yes" : "No"}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🔄 Manual trigger: http://localhost:${PORT}/sync`);
  console.log(`${"=".repeat(60)}\n`);

  // Run first sync immediately
  console.log("🎬 Running initial sync...\n");
  runSync();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n⚠️  SIGTERM received, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n⚠️  SIGINT received, shutting down gracefully...");
  process.exit(0);
});
