/* ============================================================
   FTMARKET — обычный Telegram-бот (без Mini App)
   Весь интерфейс — сообщения, фото и inline-клавиатуры.
   ============================================================ */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Bot, InlineKeyboard, GrammyError, HttpError } = require('grammy');
const path = require('path');
const fs = require('fs');
const S = require('./db');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('BOT_TOKEN не задан'); process.exit(1); }

const bot = new Bot(TOKEN);
const WELCOME_PHOTO = path.join(__dirname, '..', 'welcome.png');

/* ---------- Валидация ссылки FanPay ---------- */
const ALLOWED = ['funpay.com','www.funpay.com','funpay.ru','www.funpay.ru',
                 'fanpay.com','www.fanpay.com','fanpay.ru','www.fanpay.ru'];

function checkLink(raw) {
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, msg: 'Нужна ссылка http/https' };
    if (!ALLOWED.includes(u.hostname.toLowerCase())) return { ok: false, msg: 'Разрешены только ссылки FunPay/FanPay' };
    u.hash = '';
    return { ok: true, url: u.toString() };
  } catch { return { ok: false, msg: 'Некорректная ссылка' }; }
}

/* ---------- Утилиты ---------- */
const ADMIN_KEY = 'mq-816539-lkaithqng-01852945-oqk2@gka$`1';
const adminIds = new Set();   // сессионные админы (сбрасываются при перезапуске)

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: '🛒 Смотреть товары' }, { text: '💰 Продавать' }],
      [{ text: '👤 Мой профиль' }, { text: '🔐 админ' }]
    ],
    resize_keyboard: true
  };
}

function sellerKeyboard() {
  return {
    keyboard: [
      [{ text: '➕ Создать проект' }, { text: '📦 Мои проекты' }],
      [{ text: '↩️ Назад' }]
    ],
    resize_keyboard: true
  };
}

const CANCEL_KB = { keyboard: [[{ text: '❌ Отменить' }]], resize_keyboard: true, one_time_keyboard: true };

function projectCaption(p) {
  return `🏷 <b>${esc(p.title)}</b>\n\n💰 Цена: <b>${p.price} ₽</b>\n👤 Продавец: ${esc(p.sellerName)}\n🔗 ${esc(p.fanpayLink)}`;
}

async function sendWelcome(ctx) {
  S.upsertUser(ctx.from);
  const text =
    'Привет! 👋\n\n' +
    'Мы Ftmarket и приглашаем тебя стать частью нас!\n\n' +
    'Здесь ты можешь находить интересные товары от других пользователей, а также выставлять собственные товары с FanPay.';

  const kb = new InlineKeyboard().text('🛒 Смотреть товары','m:watch').text('💰 Продавать','m:sell').row().text('👤 Мой профиль','m:profile').text('🔐 админ','m:admin');

  if (fs.existsSync(WELCOME_PHOTO)) {
    try {
      await ctx.replyWithPhoto(new (require('grammy').InputFile)(WELCOME_PHOTO), {
        caption: text, reply_markup: kb
      });
      return;
    } catch (e) { console.error('welcome photo:', e.message); }
  }
  await ctx.reply(text, { reply_markup: kb });
}

async function showMain(ctx) {
  await ctx.reply('Главное меню:', { reply_markup: mainKeyboard() });
}

async function showSellerMenu(ctx) {
  S.upsertUser(ctx.from);
  const count = S.activeCount(ctx.from.id);
  await ctx.reply(
    `💰 <b>Меню продавца</b>\n\nПроектов: ${count} из ${S.MAX_PROJECTS}`,
    { parse_mode: 'HTML', reply_markup: sellerKeyboard() }
  );
}

/* ---------- FSM: создание проекта ---------- */
const STEP = {
  TITLE: 'new:title', PRICE: 'new:price', LINK: 'new:link',
  PHOTO1: 'new:photo1', PHOTO2: 'new:photo2', PHOTO3: 'new:photo3', PHOTO4: 'new:photo4',
  CONFIRM: 'new:confirm'
};
const PHOTO_STEPS = [STEP.PHOTO1, STEP.PHOTO2, STEP.PHOTO3, STEP.PHOTO4];

async function startNew(ctx) {
  const count = S.activeCount(ctx.from.id);
  if (count >= S.MAX_PROJECTS) {
    await ctx.reply(`⚠️ Лимит достигнут: максимум ${S.MAX_PROJECTS} проектов. Удалите один, чтобы создать новый.`);
    return;
  }
  S.setSession(ctx.from.id, STEP.TITLE, { photos: [] });
  await ctx.reply('➕ <b>Создание проекта</b>\n\nВведите <b>название товара</b>:', {
    parse_mode: 'HTML', reply_markup: CANCEL_KB
  });
}

async function askNext(ctx, state, data) {
  const idx = PHOTO_STEPS.indexOf(state);
  if (idx !== -1) {
    await ctx.reply(`📷 Отправьте <b>фотографию ${idx + 1}</b> (можно добавить от 1 до 4):`, { parse_mode: 'HTML', reply_markup: CANCEL_KB });
  }
}

async function preview(ctx, data, editId = null) {
  const kb = new InlineKeyboard()
    .text('✅ Продолжить', editId ? `edit:publish:${editId}` : 'new:publish')
    .row()
    .text('➕ Ещё фото', 'new:morephoto')
    .text('✏️ Изменить', editId ? `edit:menu:${editId}` : 'new:edit').row()
    .text('❌ Отменить', 'new:cancel');

  const caption = `🖼 <b>Предпросмотр товара</b>\n\n` +
    `🏷 ${esc(data.title)}\n💰 ${data.price} ₽\n🔗 ${esc(data.fanpayLink)}\n📷 Фото: ${data.photos.length}/4`;

  if (data.photos.length) {
    if (data.photos.length > 1) {
      const media = data.photos.map((fid, i) => ({
        type: 'photo', media: fid,
        caption: i === 0 ? caption : undefined,
        parse_mode: i === 0 ? 'HTML' : undefined
      }));
      await ctx.replyWithMediaGroup(media);
      await ctx.reply('Выберите действие:', { reply_markup: kb });
    } else {
      await ctx.replyWithPhoto(data.photos[0], { caption, parse_mode: 'HTML', reply_markup: kb });
    }
  } else {
    await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: kb });
  }
}

async function handleFSM(ctx, state, data) {
  const text = (ctx.message && ctx.message.text || '').trim();
  const id = ctx.from.id;

  if (text === '❌ Отменить') {
    S.clearSession(id);
    await ctx.reply('Создание отменено.', { reply_markup: sellerKeyboard() });
    return;
  }

  // Фото (можно загрузить от 1 до 4)
  if (PHOTO_STEPS.includes(state) || state === 'new:morephoto') {
    if (!ctx.message.photo) {
      await ctx.reply('Пожалуйста, отправьте фотографию 📷', { reply_markup: CANCEL_KB });
      return;
    }
    if (data.photos.length >= 4) {
      await ctx.reply('Максимум 4 фотографии. Завершаем.', { reply_markup: CANCEL_KB });
      S.setSession(id, STEP.CONFIRM, data);
      await preview(ctx, data);
      return;
    }
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    data.photos.push(fileId);
    S.setSession(id, STEP.CONFIRM, data);
    await preview(ctx, data);
    return;
  }

  if (state === STEP.TITLE) {
    if (!text || text.length > 100) { await ctx.reply('Введите название (до 100 символов):', { reply_markup: CANCEL_KB }); return; }
    data.title = text;
    S.setSession(id, STEP.PRICE, data);
    await ctx.reply('💰 Введите <b>цену</b> (только число):', { parse_mode: 'HTML', reply_markup: CANCEL_KB });
    return;
  }

  if (state === STEP.PRICE) {
    const price = Number(text.replace(/\s/g, ''));
    if (!Number.isFinite(price) || price <= 0) {
      await ctx.reply('❌ Неверная цена. Введите положительное число:', { reply_markup: CANCEL_KB }); return;
    }
    data.price = Math.round(price);
    S.setSession(id, STEP.LINK, data);
    await ctx.reply('🔗 Введите <b>ссылку на товар FanPay</b>:', { parse_mode: 'HTML', reply_markup: CANCEL_KB });
    return;
  }

  if (state === STEP.LINK) {
    const c = checkLink(text);
    if (!c.ok) { await ctx.reply('❌ ' + c.msg + '\nВведите ссылку ещё раз:', { reply_markup: CANCEL_KB }); return; }
    data.fanpayLink = c.url;
    S.setSession(id, STEP.PHOTO1, data);
    await askNext(ctx, STEP.PHOTO1, data);
    return;
  }
}

/* ---------- Лента ---------- */
async function showProduct(ctx, projectId = null) {
  const id = ctx.from.id;
  const fsState = S.getFeedState(id);
  const all = S.getFeedProjects(id).filter(p => !fsState.reviewed.includes(p.id));

  let p = projectId ? S.getProject(projectId) : all[0];
  if (!p || p.ownerId === id || fsState.reviewed.includes(p.id)) p = all[0];
  if (!p) {
    await ctx.reply('🎉 Вы посмотрели все товары! Нажмите «🛒 Смотреть товары», чтобы начать заново.', { reply_markup: mainKeyboard() });
    return;
  }

  S.setFeedState(id, p.id, fsState.reviewed);

  const kb = new InlineKeyboard()
    .text('🛒 Перейти на FanPay', `buy:${p.id}`).row()
    .text('⏭ SKIP', `skip:${p.id}`).text('↩️ В меню', 'm:main');

  try {
    if (p.photos.length > 1) {
      const media = p.photos.map((fid, i) => ({
        type: 'photo', media: fid,
        caption: i === 0 ? projectCaption(p) : undefined,
        parse_mode: i === 0 ? 'HTML' : undefined
      }));
      await ctx.replyWithMediaGroup(media);
      await ctx.reply('Действия:', { reply_markup: kb });
    } else {
      await ctx.replyWithPhoto(p.photos[0], { caption: projectCaption(p), parse_mode: 'HTML', reply_markup: kb });
    }
  } catch (e) {
    console.error('showProduct:', e.message);
    await ctx.reply(projectCaption(p), { parse_mode: 'HTML', reply_markup: kb });
  }
}

/* ---------- Мои проекты ---------- */
async function showMyProjects(ctx) {
  const items = S.getOwnProjects(ctx.from.id);
  if (!items.length) {
    await ctx.reply('У вас пока нет проектов. Нажмите «➕ Создать проект».', { reply_markup: sellerKeyboard() });
    return;
  }
  for (const p of items) {
    const kb = new InlineKeyboard()
      .text('✏️ Изменить', `edit:menu:${p.id}`).text('🗑 Удалить', `del:${p.id}`);
    await ctx.replyWithPhoto(p.photos[0], {
      caption: `📦 ${esc(p.title)}\n💰 ${p.price} ₽\n🔗 ${esc(p.fanpayLink)}`,
      parse_mode: 'HTML', reply_markup: kb
    });
  }
  await ctx.reply('Всего проектов: ' + items.length + ' из ' + S.MAX_PROJECTS, { reply_markup: sellerKeyboard() });
}

/* ---------- Редактирование ---------- */
async function editMenu(ctx, projectId) {
  const p = S.getProject(projectId);
  if (!p || p.ownerId !== ctx.from.id) { await ctx.reply('Проект не найден.'); return; }
  const kb = new InlineKeyboard()
    .text('🏷 Название', `ef:title:${p.id}`).text('💰 Цена', `ef:price:${p.id}`).row()
    .text('🔗 Ссылка', `ef:link:${p.id}`).text('📷 Фото', `ef:photo:${p.id}`).row()
    .text('« Назад', 'm:myprojects');
  await ctx.reply(`✏️ <b>Редактирование:</b> ${esc(p.title)}`, { parse_mode: 'HTML', reply_markup: kb });
}

const EDIT_FSM = {
  'ef:title': { state: 'edit:title', prompt: 'Введите новое название:' },
  'ef:price': { state: 'edit:price', prompt: 'Введите новую цену (число):' },
  'ef:link':  { state: 'edit:link', prompt: 'Введите новую ссылку FanPay:' },
  'ef:photo': { state: 'edit:photo', prompt: 'Отправьте 4 новые фотографии (или меньше, чтобы оставить старые):' }
};

async function handleEditFSM(ctx, state, data) {
  const id = ctx.from.id;
  const text = (ctx.message && ctx.message.text || '').trim();
  if (text === '❌ Отменить') { S.clearSession(id); await ctx.reply('Отменено.', { reply_markup: sellerKeyboard() }); return; }

  const pid = data.projectId;
  const p = S.getProject(pid);
  if (!p) { S.clearSession(id); await ctx.reply('Проект не найден.'); return; }

  if (state === 'edit:title') {
    if (!text || text.length > 100) { await ctx.reply('Введите название (до 100 символов):', { reply_markup: CANCEL_KB }); return; }
    S.updateProject(pid, { title: text });
    S.clearSession(id);
    await ctx.reply('✅ Название обновлено.', { reply_markup: sellerKeyboard() });
    return;
  }
  if (state === 'edit:price') {
    const price = Number(text.replace(/\s/g, ''));
    if (!Number.isFinite(price) || price <= 0) { await ctx.reply('❌ Неверная цена. Введите число:', { reply_markup: CANCEL_KB }); return; }
    S.updateProject(pid, { price: Math.round(price) });
    S.clearSession(id);
    await ctx.reply('✅ Цена обновлена.', { reply_markup: sellerKeyboard() });
    return;
  }
  if (state === 'edit:link') {
    const c = checkLink(text);
    if (!c.ok) { await ctx.reply('❌ ' + c.msg + '\nВведите ссылку ещё раз:', { reply_markup: CANCEL_KB }); return; }
    S.updateProject(pid, { fanpay_link: c.url });
    S.clearSession(id);
    await ctx.reply('✅ Ссылка обновлена.', { reply_markup: sellerKeyboard() });
    return;
  }
  if (state === 'edit:photo') {
    if (!ctx.message.photo) { await ctx.reply('Отправьте фотографию 📷', { reply_markup: CANCEL_KB }); return; }
    data.photos.push(ctx.message.photo[ctx.message.photo.length - 1].file_id);
    if (data.photos.length < 4) {
      S.setSession(id, state, data);
      await ctx.reply(`Фото ${data.photos.length}/4. Отправьте следующее (или напишите «готово»):`, { reply_markup: CANCEL_KB });
    } else {
      S.updateProject(pid, { photos: JSON.stringify(data.photos) });
      S.clearSession(id);
      await ctx.reply('✅ Фотографии обновлены.', { reply_markup: sellerKeyboard() });
    }
  }
}

/* ---------- Профиль ---------- */
async function showProfile(ctx) {
  const u = S.getUser(ctx.from.id) || ctx.from;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Пользователь';
  const count = S.activeCount(ctx.from.id);
  const kb = new InlineKeyboard().text('🛒 Смотреть товары','m:watch').text('💰 Продавать','m:sell');

  if (u.photo_file_id) {
    await ctx.replyWithPhoto(u.photo_file_id, {
      caption: `👤 <b>${esc(name)}</b>\n🆔 Telegram ID: <code>${ctx.from.id}</code>\n📦 Проектов: ${count} из ${S.MAX_PROJECTS}`,
      parse_mode: 'HTML', reply_markup: kb
    });
  } else {
    await ctx.reply(`👤 <b>${esc(name)}</b>\n🆔 Telegram ID: <code>${ctx.from.id}</code>\n📦 Проектов: ${count} из ${S.MAX_PROJECTS}`, {
      parse_mode: 'HTML', reply_markup: kb
    });
  }
}

/* ---------- Админ-панель ---------- */
function adminKeyboard() {
  return new InlineKeyboard()
    .text('📊 Статистика', 'ad:stats').text('👥 Пользователи', 'ad:users').row()
    .text('📦 Все товары', 'ad:products').text('📢 Рассылка', 'ad:broadcast').row()
    .text('« В меню', 'm:main');
}

async function askAdminKey(ctx) {
  S.setSession(ctx.from.id, 'admin:key', {});
  await ctx.reply('🔐 Введите ключ админ-панели:', { reply_markup: CANCEL_KB });
}

async function showAdmin(ctx) {
  adminIds.add(ctx.from.id);
  const st = S.stats();
  await ctx.reply(
    `🔐 <b>Админ-панель FTmarket</b>\n\n👤 Пользователей: ${st.users}\n📦 Товаров: ${st.projects}`,
    { parse_mode: 'HTML', reply_markup: adminKeyboard() }
  );
}

async function handleAdminKey(ctx, data) {
  const id = ctx.from.id;
  const text = (ctx.message && ctx.message.text || '').trim();
  if (text === '❌ Отменить') { S.clearSession(id); await ctx.reply('Отменено.', { reply_markup: mainKeyboard() }); return; }
  if (text === ADMIN_KEY) {
    S.clearSession(id);
    await showAdmin(ctx);
  } else {
    await ctx.reply('❌ Неверный ключ. Попробуйте ещё раз:', { reply_markup: CANCEL_KB });
  }
}

/* ---------- Команды ---------- */
bot.command('start', async (ctx) => {
  S.clearSession(ctx.from.id);
  await sendWelcome(ctx);
});

bot.command('menu', async (ctx) => showMain(ctx));

/* ---------- Текстовые кнопки ---------- */
bot.on('message:text', async (ctx) => {
  const id = ctx.from.id;
  const text = ctx.message.text.trim();
  const sess = S.getSession(id);

  // FSM имеет приоритет
  if (sess.state === 'admin:key') { await handleAdminKey(ctx, sess.data); return; }
  if (sess.state === 'admin:broadcast') {
    if (text === '❌ Отменить') { S.clearSession(id); await ctx.reply('Отменено.', { reply_markup: adminKeyboard() }); return; }
    const users = S.allUsers();
    let sent = 0;
    for (const u of users) {
      try { await bot.api.sendMessage(u.telegram_id, text); sent++; } catch { /* недоступные пользователи */ }
    }
    S.clearSession(id);
    await ctx.reply(`✅ Рассылка завершена. Отправлено: ${sent} из ${users.length}.`, { reply_markup: adminKeyboard() });
    return;
  }
  if (sess.state && sess.state.startsWith('edit:')) {
    await handleEditFSM(ctx, sess.state, sess.data); return;
  }
  if (sess.state) { await handleFSM(ctx, sess.state, sess.data); return; }

  // «готово» при редактировании фото без FSM — игнорируем
  if (text === '🛒 Смотреть товары') { await showProduct(ctx); return; }
  if (text === '💰 Продавать') { await showSellerMenu(ctx); return; }
  if (text === '👤 Мой профиль') { await showProfile(ctx); return; }
  if (text === '🔐 админ' || text === 'админ') { await askAdminKey(ctx); return; }
  if (text === '➕ Создать проект') { await startNew(ctx); return; }
  if (text === '📦 Мои проекты') { await showMyProjects(ctx); return; }
  if (text === '↩️ Назад') { await showMain(ctx); return; }

  await ctx.reply('Используйте кнопки ниже 👇', { reply_markup: mainKeyboard() });
});

// Фото вне FSM — сохраняем аватар пользователя
bot.on('message:photo', async (ctx) => {
  const id = ctx.from.id;
  const sess = S.getSession(id);
  if (sess.state) {
    if (sess.state.startsWith('edit:')) { await handleEditFSM(ctx, sess.state, sess.data); return; }
    await handleFSM(ctx, sess.state, sess.data); return;
  }
  const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  S.setUserPhoto(id, fid);
  await ctx.reply('📷 Фото сохранено в вашем профиле.');
});

/* ---------- Callback-кнопки ---------- */
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const id = ctx.from.id;
  await ctx.answerCallbackQuery().catch(() => {});

  try {
    if (data === 'm:watch') { await showProduct(ctx); return; }
    if (data === 'm:sell') { await showSellerMenu(ctx); return; }
    if (data === 'm:profile') { await showProfile(ctx); return; }
    if (data === 'm:main') { await showMain(ctx); return; }
    if (data === 'm:myprojects') { await showMyProjects(ctx); return; }
    if (data === 'm:admin') { await askAdminKey(ctx); return; }

    // Админ-панель
    if (adminIds.has(id)) {
      if (data === 'ad:stats') {
        const st = S.stats();
        await ctx.reply(`📊 <b>Статистика</b>\n\n👤 Пользователей: ${st.users}\n📦 Активных товаров: ${st.projects}`, { parse_mode: 'HTML', reply_markup: adminKeyboard() });
        return;
      }
      if (data === 'ad:users') {
        const users = S.allUsers();
        let msg = `<b>👥 Пользователи (${users.length}):</b>\n\n`;
        users.slice(0, 30).forEach((u, i) => {
          msg += `${i + 1}. ${esc([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '—')} · ID <code>${u.telegram_id}</code>\n`;
        });
        await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: adminKeyboard() });
        return;
      }
      if (data === 'ad:products') {
        const items = S.allProjects();
        if (!items.length) { await ctx.reply('Товаров нет.', { reply_markup: adminKeyboard() }); return; }
        for (const p of items.slice(0, 20)) {
          const kb = new InlineKeyboard().text('🗑 Удалить', `ad:del:${p.id}`);
          await ctx.reply(`📦 <b>${esc(p.title)}</b>\n💰 ${p.price} ₽\n👤 ${esc(p.sellerName)}`, { parse_mode: 'HTML', reply_markup: kb });
        }
        await ctx.reply('Всего товаров: ' + items.length, { reply_markup: adminKeyboard() });
        return;
      }
      if (data.startsWith('ad:del:')) {
        const pid = Number(data.split(':')[2]);
        S.deleteProject(pid);
        await ctx.reply('🗑 Товар удалён администратором.');
        return;
      }
      if (data === 'ad:broadcast') {
        S.setSession(id, 'admin:broadcast', {});
        await ctx.reply('📢 Отправьте сообщение для рассылки всем пользователям:', { reply_markup: CANCEL_KB });
        return;
      }
    }

    if (data === 'new:publish') {
      const sess = S.getSession(id);
      const d = sess.data;
      if (!d.title || !d.price || !d.fanpayLink || !d.photos.length) {
        await ctx.reply('Не все данные заполнены.'); return;
      }
      if (S.activeCount(id) >= S.MAX_PROJECTS) {
        await ctx.reply(`⚠️ Лимит ${S.MAX_PROJECTS} проектов достигнут.`); return;
      }
      S.createProject({ ownerId: id, title: d.title, price: d.price, fanpayLink: d.fanpayLink, photos: d.photos });
      S.clearSession(id);
      await ctx.reply('✅ Товар опубликован в общей ленте!', { reply_markup: sellerKeyboard() });
      return;
    }

    if (data === 'new:cancel') {
      S.clearSession(id);
      await ctx.reply('Отменено.', { reply_markup: sellerKeyboard() }); return;
    }

    if (data === 'new:morephoto') {
      const sess = S.getSession(id);
      if (!sess.data.photos || sess.data.photos.length === 0) {
        await ctx.reply('Сначала отправьте фотографию 📷'); return;
      }
      if (sess.data.photos.length >= 4) {
        S.setSession(id, STEP.CONFIRM, sess.data);
        await ctx.reply('Достигнут максимум — 4 фото.');
        await preview(ctx, sess.data); return;
      }
      S.setSession(id, 'new:morephoto', sess.data);
      await ctx.reply(`Отправьте фотографию ${sess.data.photos.length + 1}:`, { reply_markup: CANCEL_KB });
      return;
    }

    if (data === 'new:edit') {
      const sess = S.getSession(id);
      const kb = new InlineKeyboard()
        .text('🏷 Название','ne:title').text('💰 Цена','ne:price').row()
        .text('🔗 Ссылка','ne:link').text('📷 Фото','ne:photo').row()
        .text('« К предпросмотру','ne:back');
      await ctx.reply('Что изменить?', { reply_markup: kb });
      return;
    }

    if (data.startsWith('ne:')) {
      const sess = S.getSession(id);
      const d = sess.data;
      const what = data.split(':')[1];
      if (what === 'back') { await preview(ctx, d); return; }
      const prompts = {
        title: 'Введите новое название:',
        price: 'Введите новую цену (число):',
        link: 'Введите новую ссылку FanPay:',
        photo: 'Отправьте новые фотографии (до 4):'
      };
      S.setSession(id, 'newedit:' + what, { ...d, photos: what === 'photo' ? [] : d.photos });
      await ctx.reply(prompts[what], { reply_markup: CANCEL_KB });
      return;
    }

    if (data.startsWith('buy:')) {
      const p = S.getProject(Number(data.split(':')[1]));
      if (!p) { await ctx.reply('Товар не найден.'); return; }
      const kb = new InlineKeyboard().url('🛒 Открыть FanPay', p.fanpayLink);
      await ctx.reply(`🔗 Ссылка продавца на товар «${esc(p.title)}»:`, { reply_markup: kb });
      return;
    }

    if (data.startsWith('skip:')) {
      const fs = S.getFeedState(id);
      const pid = Number(data.split(':')[1]);
      if (!fs.reviewed.includes(pid)) fs.reviewed.push(pid);
      S.setFeedState(id, null, fs.reviewed);
      await ctx.deleteMessage().catch(() => {});
      await showProduct(ctx);
      return;
    }

    if (data.startsWith('edit:menu:')) {
      await editMenu(ctx, Number(data.split(':')[2])); return;
    }

    if (data.startsWith('del:')) {
      const pid = Number(data.split(':')[1]);
      S.deleteProject(pid);
      await ctx.reply('🗑 Проект удалён.', { reply_markup: sellerKeyboard() });
      return;
    }

    if (data.startsWith('ef:')) {
      const parts = data.split(':');
      const action = parts[1], pid = parts[2];
      const cfg = EDIT_FSM['ef:' + action];
      if (!cfg) return;
      S.setSession(id, cfg.state, { projectId: Number(pid), photos: [] });
      await ctx.reply(cfg.prompt, { reply_markup: CANCEL_KB });
      return;
    }
  } catch (e) {
    console.error('callback error:', e.message);
    await ctx.reply('⚠️ Ошибка. Попробуйте ещё раз.');
  }
});

/* ---------- FSM редактирования предпросмотра (newedit:) ---------- */
bot.on('message', async (ctx, next) => {
  const sess = S.getSession(ctx.from.id);
  if (!sess.state || !sess.state.startsWith('newedit:')) return next();
  const what = sess.state.split(':')[1];
  const d = sess.data;
  const text = (ctx.message.text || '').trim();

  if (text === '❌ Отменить') { S.clearSession(ctx.from.id); await ctx.reply('Отменено.', { reply_markup: sellerKeyboard() }); return; }

  if (what === 'photo') {
    if (!ctx.message.photo) { await ctx.reply('Отправьте фотографию 📷', { reply_markup: CANCEL_KB }); return; }
    d.photos.push(ctx.message.photo[ctx.message.photo.length - 1].file_id);
    if (d.photos.length < 4) {
      S.setSession(ctx.from.id, sess.state, d);
      await ctx.reply(`Фото ${d.photos.length}/4. Ещё или «готово»:`, { reply_markup: CANCEL_KB });
    } else {
      d.photos = d.photos.slice(0, 4);
      S.setSession(ctx.from.id, STEP.CONFIRM, d);
      await preview(ctx, d);
    }
    return;
  }

  if (what === 'title') {
    if (!text) { await ctx.reply('Введите название:'); return; }
    d.title = text;
  } else if (what === 'price') {
    const price = Number(text.replace(/\s/g,''));
    if (!Number.isFinite(price) || price <= 0) { await ctx.reply('Введите корректную цену:'); return; }
    d.price = Math.round(price);
  } else if (what === 'link') {
    const c = checkLink(text);
    if (!c.ok) { await ctx.reply('❌ ' + c.msg); return; }
    d.fanpayLink = c.url;
  }
  S.setSession(ctx.from.id, STEP.CONFIRM, d);
  await preview(ctx, d);
});

/* ---------- Ошибки ---------- */
bot.catch((err) => {
  const { ctx } = err;
  console.error('Bot error:', err.message);
  if (err instanceof GrammyError) {
    console.error('GrammyError:', err.description);
  } else if (err instanceof HttpError) {
    console.error('HttpError:', err.error);
  }
  ctx.reply('⚠️ Произошла ошибка. Попробуйте ещё раз.').catch(() => {});
});

/* ---------- Запуск ---------- */
console.log('🤖 FTMARKET bot starting (long polling, no web server)...');
bot.start({
  onStart: (info) => console.log(`✅ Bot @${info.username} is running`)
});
