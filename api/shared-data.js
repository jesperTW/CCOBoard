const { createClient } = require('@supabase/supabase-js');

// Kijker-accounts (alleen-lezen). Overschrijfbaar via env VIEWER_EMAILS
// (komma-gescheiden). Default: Michiel.
const VIEWER_EMAILS = (process.env.VIEWER_EMAILS || 'michiel@techniekwerkt.nl')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Geeft het gedeelde teamdashboard (meest recent bijgewerkte rij) terug aan
// kijker-accounts. Service-role omzeilt RLS, dus de kijker hoeft geen
// leesrechten op de rij van de eigenaar te hebben.
module.exports = async function handler(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });

  const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ error: 'Sessie ongeldig' });

  const email = (userData.user.email || '').toLowerCase();
  if (!VIEWER_EMAILS.includes(email)) {
    return res.status(403).json({ error: 'Dit account is geen kijker-account' });
  }

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('dashboard_data')
      .select('data,user_id,updated_at')
      .order('updated_at', { ascending: false })
      .limit(5);
    if (error) throw error;

    // Pak de meest recente rij die NIET van de kijker zelf is (= de eigenaar).
    const ownerRow = (rows || []).find(r => r.user_id !== userData.user.id) || (rows || [])[0];
    return res.json({ data: ownerRow?.data || null });
  } catch (err) {
    console.error('shared-data', err);
    return res.status(500).json({ error: err.message });
  }
};
