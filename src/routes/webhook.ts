import { Router } from "express";
import * as express from "express";
import * as crypto from "crypto";
import { env } from "../config/env";
import { processMessage } from "../services/commands";

// Kapso webhook payload format (batched)
interface KapsoMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  timestamp: string;
}

interface KapsoBatchItem {
  message: KapsoMessage;
  conversation?: { id: string };
  contact?: { wa_id: string; profile?: { name: string } };
}

interface KapsoWebhookPayload {
  type: string;        // "whatsapp.message.received"
  batch: boolean;
  data: KapsoBatchItem[];
}

const router = Router();

function verifyHmacSignature(rawBody: Buffer, signature: string): boolean {
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

    console.log('[webhook] Received event:', req.headers['x-webhook-event']);

    // Verify signature — MANDATORY
    if (!signature || typeof signature !== "string") {
      console.warn('[webhook] Missing signature header — rejecting request');
      res.status(401).json({ error: "Missing X-Webhook-Signature" });
      return;
    }
    if (!verifyHmacSignature(rawBody, signature)) {
      console.warn('[webhook] Signature mismatch — rejecting request');
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    let payload: KapsoWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as KapsoWebhookPayload;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    // Respond immediately to avoid Kapso timeout
    res.status(200).json({ received: true });

    // Check event type (Kapso uses "type" not "event")
    if (payload.type !== "whatsapp.message.received") {
      console.log(`[webhook] Skipping event type: ${payload.type}`);
      return;
    }

    // Process batched messages
    const items = Array.isArray(payload.data) ? payload.data : [payload.data];

    for (const item of items) {
      const msg = item.message;
      if (!msg) {
        console.log('[webhook] No message in batch item, skipping');
        continue;
      }

      if (msg.type !== "text" || !msg.text?.body) {
        console.log(`[webhook] Skipping non-text message type: ${msg.type}`);
        continue;
      }

      const senderPhone = msg.from;
      const messageText = msg.text.body;

      console.log(`[webhook] Processing message from ${senderPhone}: "${messageText}"`);

      processMessage(senderPhone, messageText).catch((err) => {
        console.error(`[webhook] Error processing message from ${senderPhone}:`, err);
      });
    }
  }
);

router.get("/webhook", (_req, res) => {
  res.status(200).json({ status: "ok", service: "satspilot-webhook" });
});

export default router;
