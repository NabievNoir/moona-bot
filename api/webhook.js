const BOT_TOKEN = '8987560398:AAEC0YEqBFe3C5yFxQfHmjedmJmeYe9plGM';
const SUPABASE_URL = 'https://pedchyiwcnlwzzgkmxxj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_03ShnchlS8pIOfvC4tfKPA_IHFHvUzs';

const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  return r.json();
};

const db = {
  async get(table, filter='') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      headers: {'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`}
    });
    return r.json();
  },
  async post(table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    return r.json();
  },
  async patch(table, id, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    return r.json();
  }
};

// In-memory sessions (works for serverless)
const sessions = {};
const getSession = (id) => sessions[id] || (sessions[id] = {step: 'start'});
const setSession = (id, d) => { sessions[id] = {...getSession(id), ...d}; };
const clearSession = (id) => { sessions[id] = {step: 'start'}; };

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const session = getSession(chatId);

  // Check if registered staff
  const staff = await db.get('users', `telegram_id=eq.${chatId}`);
  const isStaff = Array.isArray(staff) && staff.length > 0;

  if (text === '/start') {
    clearSession(chatId);
    if (isStaff) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `👋 Привет, ${staff[0].name}!\n\nТы подключён как *${staff[0].rl}*.\n\nБудешь получать уведомления автоматически. ✅`,
        parse_mode: 'Markdown',
        reply_markup: {keyboard: [[{text: '📊 Мои задачи'}]], resize_keyboard: true}
      });
    } else {
      setSession(chatId, {step: 'ask_role'});
      await tg('sendMessage', {
        chat_id: chatId,
        text: '👋 Добро пожаловать в *MOONA*!\n\nВы сотрудник или представитель магазина?',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{text: '🏪 Хочу заказать товар', callback_data: 'role_market'}],
            [{text: '👤 Я сотрудник MOONA', callback_data: 'role_staff'}]
          ]
        }
      });
    }
    return;
  }

  // Staff login - step 1: enter login
  if (session.step === 'staff_code') {
    setSession(chatId, {step: 'staff_password', staff_login: text});
    await tg('sendMessage', {chat_id: chatId, text: '🔒 Введите ваш пароль:'});
    return;
  }

  // Staff login - step 2: enter password
  if (session.step === 'staff_password') {
    const users = await db.get('users', `login=eq.${session.staff_login}`);
    if (Array.isArray(users) && users.length > 0) {
      const user = users[0];
      if (user.pass === text) {
        await db.patch('users', user.id, {telegram_id: String(chatId)});
        clearSession(chatId);
        await tg('sendMessage', {
          chat_id: chatId,
          text: `✅ Готово! Вы подключены как *${user.name}* (${user.rl}).\n\nТеперь будете получать уведомления о заказах.`,
          parse_mode: 'Markdown',
          reply_markup: {keyboard: [[{text: '📊 Мои задачи'}]], resize_keyboard: true}
        });
      } else {
        clearSession(chatId);
        await tg('sendMessage', {chat_id: chatId, text: '❌ Неверный пароль. Попробуйте снова /start'});
      }
    } else {
      clearSession(chatId);
      await tg('sendMessage', {chat_id: chatId, text: '❌ Логин не найден. Попробуйте снова /start'});
    }
    return;
  }

  // Market registration flow
  if (session.step === 'market_name') {
    setSession(chatId, {step: 'market_phone', market_name: text});
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📞 Введите номер телефона:',
      reply_markup: {
        keyboard: [[{text: '📱 Отправить мой номер', request_contact: true}]],
        resize_keyboard: true, one_time_keyboard: true
      }
    });
    return;
  }

  if (session.step === 'market_phone') {
    const phone = msg.contact ? msg.contact.phone_number : text;
    setSession(chatId, {step: 'market_location', market_phone: phone});
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📍 Отправьте вашу локацию:',
      reply_markup: {
        keyboard: [[{text: '📍 Отправить локацию', request_location: true}]],
        resize_keyboard: true, one_time_keyboard: true
      }
    });
    return;
  }

  if (session.step === 'market_order') {
    setSession(chatId, {step: 'confirm_order', order_text: text});
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📋 Ваш заказ:\n\n${text}\n\nПодтвердить?`,
      reply_markup: {
        inline_keyboard: [
          [{text: '✅ Подтвердить', callback_data: 'confirm_order'}],
          [{text: '✏️ Изменить', callback_data: 'edit_order'}]
        ]
      }
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
      market_lng: msg.location.longitude
    });
    const prods = await db.get('products', 'order=id');
    let text = '📦 *Доступные товары:*\n\n';
    if (Array.isArray(prods)) {
      prods.forEach(p => {
        text += `• ${p.name} — ${Number(p.price).toLocaleString('ru')} сум/${p.unit}\n`;
      });
    }
    text += '\n✍️ Напишите заказ в формате:\n_Патти 100г - 50 шт\nСосиски - 20 упак_';
    await tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'Markdown',
      reply_markup: {remove_keyboard: true}
    });
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  await tg('answerCallbackQuery', {callback_query_id: query.id});

  if (data === 'role_market') {
    setSession(chatId, {step: 'market_name', is_market: true});
    await tg('sendMessage', {chat_id: chatId, text: '🏪 Введите название вашего магазина:'});
  }

  if (data === 'role_staff') {
    setSession(chatId, {step: 'staff_code'});
    await tg('sendMessage', {chat_id: chatId, text: '👤 Введите ваш логин в системе MOONA (например: admin, agent1...):'});
  }

  if (data === 'confirm_order') {
    const session = getSession(chatId);
    const mapLink = `https://maps.google.com/?q=${session.market_lat},${session.market_lng}`;
    const notif = `🆕 *Новая заявка от магазина!*\n\n🏪 *${session.market_name}*\n📞 ${session.market_phone}\n📍 [Открыть локацию](${mapLink})\n\n📋 *Заказ:*\n${session.order_text}\n\n🕐 ${new Date().toLocaleString('ru-RU')}`;

    // Notify all managers
    const managers = await db.get('users', 'role=eq.manager');
    if (Array.isArray(managers)) {
      for (const mgr of managers) {
        if (mgr.telegram_id) {
          await tg('sendMessage', {
            chat_id: mgr.telegram_id,
            text: notif,
            parse_mode: 'Markdown'
          });
        }
      }
    }

    // Also notify admin
    const admins = await db.get('users', 'role=eq.admin');
    if (Array.isArray(admins)) {
      for (const adm of admins) {
        if (adm.telegram_id) {
          await tg('sendMessage', {chat_id: adm.telegram_id, text: notif, parse_mode: 'Markdown'});
        }
      }
    }

    clearSession(chatId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ Заявка отправлена!\n\nМенеджер свяжется с вами в ближайшее время.',
      reply_markup: {
        inline_keyboard: [[{text: '🔄 Сделать ещё заказ', callback_data: 'new_order'}]]
      }
    });
  }

  if (data === 'edit_order') {
    setSession(chatId, {step: 'market_order'});
    await tg('sendMessage', {chat_id: chatId, text: '✏️ Введите заказ заново:'});
  }

  if (data === 'new_order') {
    const session = getSession(chatId);
    setSession(chatId, {step: 'market_order', market_name: session.market_name, market_phone: session.market_phone, market_lat: session.market_lat, market_lng: session.market_lng});
    const prods = await db.get('products', 'order=id');
    let text = '📦 *Доступные товары:*\n\n';
    if (Array.isArray(prods)) {
      prods.forEach(p => { text += `• ${p.name} — ${Number(p.price).toLocaleString('ru')} сум/${p.unit}\n`; });
    }
    text += '\n✍️ Напишите ваш заказ:';
    await tg('sendMessage', {chat_id: chatId, text, parse_mode: 'Markdown'});
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ok: true});
  try {
    const body = req.body;
    if (body.message) {
      if (body.message.location) await handleLocation(body.message);
      else if (body.message.contact) await handleMessage(body.message);
      else await handleMessage(body.message);
    }
    if (body.callback_query) await handleCallback(body.callback_query);
  } catch(e) {
    console.error('Bot error:', e);
  }
  res.status(200).json({ok: true});
}
