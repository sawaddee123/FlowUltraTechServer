import { env } from "../config/env.js";

/**
 * Send an HTML-formatted text message to a Telegram chat
 */
export const sendTelegramMessage = async (
  botToken: string,
  chatId: string,
  message: string
): Promise<boolean> => {
  const token = botToken || env.TELEGRAM_DEFAULT_BOT_TOKEN;
  if (!token || !chatId || !message) {
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${token.trim()}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[telegram] Failed to send message (HTTP ${res.status}): ${errText}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[telegram] Network error sending message:", error);
    return false;
  }
};

/**
 * Send a photo with an HTML caption to a Telegram chat
 */
export const sendTelegramPhoto = async (
  botToken: string,
  chatId: string,
  photoBuffer: Buffer,
  caption?: string,
  filename: string = "captcha.png"
): Promise<boolean> => {
  const token = botToken || env.TELEGRAM_DEFAULT_BOT_TOKEN;
  if (!token || !chatId || !photoBuffer || photoBuffer.length === 0) {
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${token.trim()}/sendPhoto`;
    const formData = new FormData();
    formData.append("chat_id", chatId.trim());
    formData.append("photo", new Blob([photoBuffer]), filename);

    if (caption) {
      formData.append("caption", caption);
      formData.append("parse_mode", "HTML");
    }

    const res = await fetch(url, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[telegram] Failed to send photo (HTTP ${res.status}): ${errText}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[telegram] Network error sending photo:", error);
    return false;
  }
};
