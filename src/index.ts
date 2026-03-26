import "dotenv/config";
import express from "express";
import webhookRouter from "./routes/webhook";
import { env } from "./config/env";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { startDepositWatcher, stopDepositWatcher } from "./services/deposit-watcher";

const app = express();

// Webhook router must be mounted before express.json() so that
// express.raw() on the /webhook POST route can read the raw body for HMAC verification.
app.use("/", webhookRouter);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", name: "satspilot" });
});

const server = app.listen(env.PORT, () => {
  console.log(`satspilot running on port ${env.PORT}`);

  startScheduler();
  startDepositWatcher();

  console.log("All services started. SatsPilot is ready.");
});

function gracefulShutdown(signal: string): void {
  console.log(`\n[shutdown] ${signal} received. Shutting down gracefully...`);
  stopScheduler();
  stopDepositWatcher();
  server.close(() => {
    console.log("[shutdown] HTTP server closed. Goodbye.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
