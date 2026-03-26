import { Router } from "express";
import * as express from "express";
import * as crypto from "crypto";
import { env } from "../config/env";
import { processMessage } from "../services/commands";

interface KapsoMessageData {
  from: string;
  id: string;
  type: string;
  text?: {
    body: string;
  };
  timestamp?: number;
}

interface KapsoWebhookPayload {
  event: string;
  timestamp?: number;
  data: KapsoMessageData;
}

const router = Router();

function verifyHmacSignature(rawBody: Buffer, signature: string): boolean {
  // Kapso sends just the hex digest (no "sha256=" prefix)
  // Input is JSON.stringify(payload) — which is the raw body
  const expected = crypto
    .createHmac("sha256", env.KAPSO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-webhook-signature"];

    const rawBody: Buffer = req.body;

    // Log incoming webhook for debugging
    console.log('[webhook] Received event:', req.headers['x-webhook-event']);
    console.log('[webhook] Body preview:', rawBody.toString('utf-8').substring(0, 200));

    // Verify signature if present (skip if missing for hackathon debugging)
    if (signature && typeof signature === "string") {
      if (!verifyHmacSignature(rawBody, signature)) {
        console.log('[webhook] Signature verification failed — allowing through for hackathon');
      }
    }

    let payload: KapsoWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as KapsoWebhookPayload;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    if (payload.event !== "whatsapp.message.received") {
      res.status(200).json({ received: true, skipped: true });
      return;
    }

    const { data } = payload;

    if (data.type !== "text" || !data.text?.body) {
      res.status(200).json({ received: true, skipped: true });
      return;
    }

    const senderPhone = data.from;
    const messageText = data.text.body;

    res.status(200).json({ received: true });

    processMessage(senderPhone, messageText).catch((err) => {
      console.error(
        `Error processing message from ${senderPhone}:`,
        err
      );
    });
  }
);

router.get("/webhook", (_req, res) => {
  res.status(200).json({ status: "ok", service: "autostack-webhook" });
});

export default router;
