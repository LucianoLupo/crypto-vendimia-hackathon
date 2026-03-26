import "dotenv/config";
import express from "express";
import webhookRouter from "./routes/webhook";
import { env } from "./config/env";
import { startScheduler } from "./services/scheduler";
import { startDepositWatcher } from "./services/deposit-watcher";

const app = express();

// Webhook router must be mounted before express.json() so that
// express.raw() on the /webhook POST route can read the raw body for HMAC verification.
app.use("/", webhookRouter);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", name: "autostack-bot" });
});

app.listen(env.PORT, () => {
  console.log(`autostack-bot running on port ${env.PORT}`);

  startScheduler();
  startDepositWatcher();

  console.log("All services started. AutoStack is ready.");
});
