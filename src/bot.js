import { Bot } from 'grammy';
import { config } from './config.js';
import { getDb } from './db.js';
import { setBot } from './notify.js';

export async function startBot(app) {
  if (!config.botToken) {
    app.log.warn('[bot] BOT_TOKEN not set, skipping bot startup');
    return null;
  }

  const bot = new Bot(config.botToken);
  setBot(bot);

  bot.command('start', (ctx) => {
    if (!config.webappUrl) {
      return ctx.reply('Бот онлайн, но WEBAPP_URL не настроен. Поставь и рестартни.');
    }
    return ctx.reply('Здарова, чемпион(-ка)! Го катку👇', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Играть', web_app: { url: config.webappUrl } }],
        ],
      },
    });
  });

  bot.on('message:photo', async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const db = getDb();
    const user = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(tgId);
    if (!user) {
      await ctx.reply('Сначала открой приложение через /start, чтобы зарегистрироваться, потом возвращайся с фоткой.');
      return;
    }
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    db.prepare('UPDATE users SET avatar_file_id = ? WHERE tg_id = ?').run(photo.file_id, tgId);
    await ctx.reply('Аватарка обновлена 🤘');
  });

  if (config.botMode === 'polling') {
    bot.start({ onStart: () => app.log.info('[bot] polling started') });
  } else {
    if (!config.webhookUrl) {
      app.log.warn('[bot] BOT_MODE=webhook but WEBHOOK_URL not set');
    } else {
      await bot.api.setWebhook(`${config.webhookUrl}/bot/webhook`);
      app.log.info(`[bot] webhook set to ${config.webhookUrl}/bot/webhook`);
    }
  }

  return bot;
}

export async function getAvatarUrl(fileId) {
  if (!fileId || !config.botToken) return null;
  const res = await fetch(
    `https://api.telegram.org/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const data = await res.json();
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${config.botToken}/${data.result.file_path}`;
}
