// Bot notifications — used by routes to push messages to players when game state changes.
// The bot instance is injected from bot.js after the Telegram client is alive.

import { config } from './config.js';

let bot = null;

export function setBot(b) { bot = b; }

// Fire-and-forget message. Logs failure (commonly: user hasn't started the bot) but
// never throws — callers must not have request flow blocked on Telegram delivery.
export function notify(tgId, text, opts = {}) {
  if (!bot || !tgId) return;
  bot.api.sendMessage(tgId, text, opts).catch((err) => {
    // Block reasons: user never opened the bot, or blocked it. Not actionable on our side.
    console.warn(`[notify] sendMessage(${tgId}) failed:`, err.description || err.message);
  });
}

// Convenience: notification with an inline button that deep-links into the room.
export function notifyRoom(tgId, text, roomId) {
  if (!config.webappUrl) {
    notify(tgId, text);
    return;
  }
  notify(tgId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Открыть комнату', web_app: { url: `${config.webappUrl}/#/rooms/${roomId}` } },
      ]],
    },
  });
}
