// line.js
// Minimal LINE Messaging API helpers — signature verification + reply.
// No SDK dependency; uses Node 18+ built-in crypto and global fetch.

import crypto from "node:crypto";

const REPLY_URL = "https://api.line.me/v2/bot/message/reply";

/**
 * Verify the X-Line-Signature header against the RAW request body.
 * @param {Buffer|string} rawBody - exact bytes LINE sent (do NOT re-stringify parsed JSON)
 * @param {string} signature - value of the "x-line-signature" header
 * @param {string} channelSecret
 * @returns {boolean}
 */
export function verifySignature(rawBody, signature, channelSecret) {
  if (!channelSecret || !signature) return false;
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch
  }
}

/**
 * Reply with a plain text message. Truncates to LINE's 5000-char limit.
 * @returns {Promise<{ok:boolean, status?:number, skipped?:boolean}>}
 */
export async function replyText(replyToken, text, channelAccessToken) {
  if (!channelAccessToken) return { ok: false, skipped: true }; // dev mode, no creds
  let body = String(text ?? "");
  if (body.length > 4900) body = body.slice(0, 4900) + "\n…(truncated)";
  const res = await fetch(REPLY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: body }] }),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Reply to a LINE event. By default sends the human-readable Thai
 * `summary.message` if present, otherwise the structured JSON pretty-printed
 * (LINE has no native JSON bubble).
 * @returns {Promise<{ok:boolean, status?:number, skipped?:boolean}>}
 */
export async function replyJson(replyToken, payload, channelAccessToken, { humanFirst = true } = {}) {
  const human = humanFirst && payload?.summary?.message;
  const text = human ? payload.summary.message : JSON.stringify(payload, null, 2);
  return replyText(replyToken, text, channelAccessToken);
}
