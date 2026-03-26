import { env } from "../config/env";

const KAPSO_BASE_URL = "https://api.kapso.ai/meta/whatsapp/v24.0";

export async function sendMessage(to: string, body: string): Promise<void> {
  const url = `${KAPSO_BASE_URL}/${env.KAPSO_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-Key": env.KAPSO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `Kapso API error [${response.status}] sending to ${to}: ${text}`
      );
    }
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${to}:`, error);
  }
}
