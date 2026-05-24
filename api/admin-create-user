// ============================================================
// MOONA ERP — /api/admin-create-user
// Создаёт сотрудника: юзер в Supabase Auth + строка в users (связка).
// Только админ. Только сервер (service_role).
// ============================================================
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

const ROLE_LABELS = {
  admin: 'Администратор', manager: 'Менеджер', agent: 'Агент',
  driver: 'Доставщик', warehouse: 'Завхоз (Склад)',
  distrib: 'Завхоз (РП)', merch: 'Мерчандайзер',
};

async function authAdmin(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
async function dbGet(filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?${filter}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return r.json();
}
async function dbPost(data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(data),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return res.status(500).json({ error: 'env_missing' });

  try {
    const { name, login, password, role } = req.body || {};

    // 1) Проверяем, что зовёт админ
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'no_token' });
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!who.ok) return res.status(401).json({ error: 'bad_token' });
    const caller = await who.json();
    const callerRows = await dbGet(`auth_user_id=eq.${caller.id}&select=role`);
    if ((Array.isArray(callerRows) && callerRows[0]?.role) !== 'admin') {
      return res.status(403).json({ error: 'not_admin' });
    }

    // 2) Валидация
    if (!name || !login || !password || String(password).length < 6 || !ROLE_LABELS[role]) {
      return res.status(400).json({ error: 'bad_input' });
    }
    const cleanLogin = String(login).trim().toLowerCase();
    const email = cleanLogin.includes('@') ? cleanLogin : `${cleanLogin}@moona.local`;

    // Не дублируем логин
    const exists = await dbGet(`login=eq.${cleanLogin}&select=id`);
    if (Array.isArray(exists) && exists.length) return res.status(409).json({ error: 'login_exists' });

    // 3) Создаём юзера в Supabase Auth (email сразу подтверждён)
    const created = await authAdmin('POST', 'users', {
      email, password: String(password), email_confirm: true,
    });
    if (!created.ok || !created.data?.id) {
      return res.status(500).json({ error: 'auth_create_failed', detail: created.data });
    }

    // 4) Создаём строку в users со связкой auth_user_id
    const row = await dbPost({
      name, login: cleanLogin, role, rl: ROLE_LABELS[role],
      auth_user_id: created.data.id, pass: null,
    });
    if (!row.ok) {
      // откат: удаляем созданного Auth-юзера, чтобы не было «осиротевшего» аккаунта
      await authAdmin('DELETE', `users/${created.data.id}`);
      return res.status(500).json({ error: 'db_insert_failed', detail: row.data });
    }

    const newUser = Array.isArray(row.data) ? row.data[0] : row.data;
    return res.status(200).json({ ok: true, user: newUser });
  } catch (e) {
    console.error('admin-create-user error:', e);
    return res.status(500).json({ error: 'server', detail: String(e) });
  }
}
