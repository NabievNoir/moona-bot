// ============================================================
// MOONA ERP — Telegram bot webhook (вариант B: Supabase Auth)
// ============================================================
// ENV (Vercel → Settings → Environment Variables):
//   BOT_TOKEN          = <НОВЫЙ токен от @BotFather, старый перевыпустить!>
//   SUPABASE_URL       = https://pedchyiwcnlwzzgkmxxj.supabase.co
//   SUPABASE_ANON_KEY  = <публичный anon-ключ>
// Бот НЕ хранит и НЕ проверяет пароли сам — этим занимается Supabase Auth.
// ============================================================

const BOT_TOKEN    = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

const db = {
  async get(table, filter = '') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    return r.json();
  },
  async patch(table, id, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async post(table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(data),
    });
    return r.json();
  },
};

// --- Supabase Auth helpers --------------------------------------
// Вход по email+паролю. Возвращает токены либо null при неверном пароле.
async function authSignIn(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return null;
  return r.json(); // { access_token, refresh_token, user, ... }
}

// Проверка, что бот-сессия ещё жива. Если админ сменил пароль и погасил
// сессии — refresh упадёт, и мы поймём, что нужно разлогинить.
async function authRefreshValid(refreshToken) {
  if (!refreshToken) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!r.ok) return false;
  const d = await r.json();
  return d?.refresh_token || false; // вернётся обновлённый токен
}

// In-memory sessions (для пошаговых диалогов)
const sessions = {};
const getSession = (id) => sessions[id] || (sessions[id] = { step: 'start' });
const setSession = (id, d) => { sessions[id] = { ...getSession(id), ...d }; };
const clearSession = (id) => { sessions[id] = { step: 'start' }; };

// Возвращает залогиненного сотрудника по chatId ИЛИ null, если разлогинен.
// Если пароль сменили — стирает привязку и уведомляет.
async function getActiveStaff(chatId) {
  const staff = await db.get('users', `telegram_id=eq.${chatId}`);
  if (!Array.isArray(staff) || staff.length === 0) return null;
  const user = staff[0];

  const fresh = await authRefreshValid(user.tg_refresh_token);
  if (!fresh) {
    // Сессия мертва (пароль сменён админом или токена нет) → разлогин
    await db.patch('users', user.id, { telegram_id: null, tg_refresh_token: null });
    return null;
  }
  // Обновляем refresh-токен (ротация) и продолжаем
  if (fresh !== user.tg_refresh_token) {
    await db.patch('users', user.id, { tg_refresh_token: fresh });
  }
  return user;
}

const loginPrompt = (chatId, extra = '') =>
  tg('sendMessage', {
    chat_id: chatId,
    text: `${extra}🔐 Пожалуйста, войдите заново.\n\nОтправьте /start, затем «Я сотрудник MOONA» и ваш логин и пароль.`,
    parse_mode: 'Markdown',
  });

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const session = getSession(chatId);

  if (text === '/start') {
    clearSession(chatId);
    const user = await getActiveStaff(chatId);
    if (user) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `👋 Привет, ${user.name}!\n\nТы подключён как *${user.rl}*.\n\nБудешь получать уведомления автоматически. ✅`,
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [[{ text: '📊 Мои задачи' }]], resize_keyboard: true },
      });
    } else {
      setSession(chatId, { step: 'ask_role' });
      await tg('sendMessage', {
        chat_id: chatId,
        text: '👋 Добро пожаловать в *MOONA*!\n\nВы сотрудник или представитель магазина?',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏪 Хочу заказать товар', callback_data: 'role_market' }],
            [{ text: '👤 Я сотрудник MOONA', callback_data: 'role_staff' }],
          ],
        },
      });
    }
    return;
  }

  // Staff login — шаг 1: логин
  if (session.step === 'staff_code') {
    setSession(chatId, { step: 'staff_password', staff_login: text.trim() });
    await tg('sendMessage', { chat_id: chatId, text: '🔒 Введите ваш пароль:' });
    return;
  }

  // Staff login — шаг 2: пароль → проверка через Supabase Auth
  if (session.step === 'staff_password') {
    const login = session.staff_login;
    const email = login.includes('@') ? login : `${login}@moona.local`;
    const auth = await authSignIn(email, text);

    if (!auth || !auth.user) {
      clearSession(chatId);
      await tg('sendMessage', { chat_id: chatId, text: '❌ Неверный логин или пароль. Попробуйте снова /start' });
      return;
    }
    // Находим строку в users по auth_user_id
    const rows = await db.get('users', `auth_user_id=eq.${auth.user.id}`);
    if (!Array.isArray(rows) || rows.length === 0) {
      clearSession(chatId);
      await tg('sendMessage', { chat_id: chatId, text: '❌ Учётка не привязана. Обратитесь к администратору.' });
      return;
    }
    const user = rows[0];
    // Сохраняем привязку + refresh-токен (по нему потом проверяем жизнь сессии)
    await db.patch('users', user.id, {
      telegram_id: String(chatId),
      tg_refresh_token: auth.refresh_token,
    });
    clearSession(chatId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Готово! Вы подключены как *${user.name}* (${user.rl}).\n\nТеперь будете получать уведомления о заказах.`,
      parse_mode: 'Markdown',
      reply_markup: { keyboard: [[{ text: '📊 Мои задачи' }]], resize_keyboard: true },
    });
    return;
  }

  // --- Market registration flow (без изменений) ------------------
  if (session.step === 'market_name') {
    setSession(chatId, { step: 'market_phone', market_name: text });
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📞 Введите номер телефона:',
      reply_markup: {
        keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
    return;
  }
  if (session.step === 'market_phone') {
    const phone = msg.contact ? msg.contact.phone_number : text;
    setSession(chatId, { step: 'market_location', market_phone: phone });
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📍 Отправьте вашу локацию:',
      reply_markup: {
        keyboard: [[{ text: '📍 Отправить локацию', request_location: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
    return;
  }
  if (session.step === 'market_order') {
    setSession(chatId, { step: 'confirm_order', order_text: text });
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📋 Ваш заказ:\n\n${text}\n\nПодтвердить?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Подтвердить', callback_data: 'confirm_order' }],
          [{ text: '✏️ Изменить', callback_data: 'edit_order' }],
        ],
      },
    });
    return;
  }
}

async function handleLocation(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.step === 'market_location') {
    setSession(chatId, {
      step: 'market_order',
      market_lat: msg.location.latitude,
      market_lng: msg.location.longitude,
    });
    const prods = await db.get('products', 'order=id');
    let text = '📦 *Доступные товары:*\n\n';
    if (Array.isArray(prods)) {
      prods.forEach((p) => {
        text += `• ${p.name} — ${Number(p.price).toLocaleString('ru')} сум/${p.unit}\n`;
      });
    }
    text += '\n✍️ Напишите заказ в формате:\n_Патти 100г - 50 шт\nСосиски - 20 упак_';
    await tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'Markdown',
      reply_markup: { remove_keyboard: true },
    });
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  await tg('answerCallbackQuery', { callback_query_id: query.id });

  if (data === 'role_market') {
    setSession(chatId, { step: 'market_name', is_market: true });
    await tg('sendMessage', { chat_id: chatId, text: '🏪 Введите название вашего магазина:' });
  }

  if (data === 'role_staff') {
    setSession(chatId, { step: 'staff_code' });
    await tg('sendMessage', { chat_id: chatId, text: '👤 Введите ваш логин в системе MOONA (например: admin, agent1...):' });
  }

  if (data === 'confirm_order') {
    const session = getSession(chatId);
    const mapLink = `https://maps.google.com/?q=${session.market_lat},${session.market_lng}`;
    const notif = `🆕 *Новая заявка от магазина!*\n\n🏪 *${session.market_name}*\n📞 ${session.market_phone}\n📍 [Открыть локацию](${mapLink})\n\n📋 *Заказ:*\n${session.order_text}\n\n🕐 ${new Date().toLocaleString('ru-RU')}`;

    const managers = await db.get('users', 'role=eq.manager');
    if (Array.isArray(managers)) {
      for (const mgr of managers) {
        if (mgr.telegram_id) await tg('sendMessage', { chat_id: mgr.telegram_id, text: notif, parse_mode: 'Markdown' });
      }
    }
    const admins = await db.get('users', 'role=eq.admin');
    if (Array.isArray(admins)) {
      for (const adm of admins) {
        if (adm.telegram_id) await tg('sendMessage', { chat_id: adm.telegram_id, text: notif, parse_mode: 'Markdown' });
      }
    }

    clearSession(chatId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ Заявка отправлена!\n\nМенеджер свяжется с вами в ближайшее время.',
      reply_markup: { inline_keyboard: [[{ text: '🔄 Сделать ещё заказ', callback_data: 'new_order' }]] },
    });
  }

  if (data === 'edit_order') {
    setSession(chatId, { step: 'market_order' });
    await tg('sendMessage', { chat_id: chatId, text: '✏️ Введите заказ заново:' });
  }

  if (data === 'new_order') {
    const session = getSession(chatId);
    setSession(chatId, {
      step: 'market_order',
      market_name: session.market_name, market_phone: session.market_phone,
      market_lat: session.market_lat, market_lng: session.market_lng,
    });
    const prods = await db.get('products', 'order=id');
    let text = '📦 *Доступные товары:*\n\n';
    if (Array.isArray(prods)) {
      prods.forEach((p) => { text += `• ${p.name} — ${Number(p.price).toLocaleString('ru')} сум/${p.unit}\n`; });
    }
    text += '\n✍️ Напишите ваш заказ:';
    await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  try {
    const body = req.body;
    if (body.message) {
      if (body.message.location) await handleLocation(body.message);
      else await handleMessage(body.message);
    }
    if (body.callback_query) await handleCallback(body.callback_query);
  } catch (e) {
    console.error('Bot error:', e);
  }
  res.status(200).json({ ok: true });
}
