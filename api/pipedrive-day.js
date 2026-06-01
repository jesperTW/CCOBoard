const { createClient } = require('@supabase/supabase-js');

// ── Config (overschrijfbaar via Vercel env vars) ──────────────────────────────
const PD_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PD_DOMAIN = process.env.PIPEDRIVE_DOMAIN; // bv. "techniekwerkt" uit techniekwerkt.pipedrive.com
const ACQ_TYPE_NAME = process.env.PIPEDRIVE_ACQ_TYPE || 'Acquisitie'; // -> gebeld
const MEETING_TYPE_NAME = process.env.PIPEDRIVE_MEETING_TYPE || 'Meeting'; // -> afspraken

const PD_BASE = PD_DOMAIN
  ? `https://${PD_DOMAIN}.pipedrive.com/api/v1`
  : 'https://api.pipedrive.com/v1';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  // ── Auth: alleen ingelogde CCOboard-gebruikers ──────────────────────────────
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ error: 'Sessie ongeldig' });

  if (!PD_TOKEN) return res.status(500).json({ error: 'PIPEDRIVE_API_TOKEN ontbreekt in Vercel' });

  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Ongeldige datum (verwacht YYYY-MM-DD)' });

  try {
    // Mappings parallel ophalen
    const [users, actTypes] = await Promise.all([
      fetchUsers(),
      fetchActivityTypes()
    ]);

    const acqKey = actTypes[ACQ_TYPE_NAME.toLowerCase()];
    const meetKey = actTypes[MEETING_TYPE_NAME.toLowerCase()] || 'meeting';

    // ── Activiteiten per gebruiker ────────────────────────────────────────────
    // 'gebeld' en 'afsprakenDoor' tellen op AFROND-datum (marked_as_done_time =
    // die dag), net als de Pipedrive Acquisitie-grafiek. Pipedrive's datumfilter
    // werkt op due_date, niet op afrond-datum, dus we halen een ruim venster
    // afgeronde activiteiten op en filteren in code op afrond-datum.
    //   gebeld        = Acquisitie-calls die die dag zijn afgerond
    //   afsprakenDoor = Meetings die die dag zijn afgerond (meeting gehad)
    // 'afspraken' (ingepland) wordt NIET meer berekend — die voert de gebruiker handmatig in.
    const activities = await fetchDoneActivitiesCompletedOn(date);
    const perUser = {}; // user_id -> {gebeld, afspraken, afsprakenDoor, deals, omzet, verloren, openDeals, openWaarde}
    const ensure = (uid) => (perUser[uid] = perUser[uid] || { gebeld: 0, afspraken: 0, afsprakenDoor: 0, deals: 0, omzet: 0, verloren: 0, openDeals: 0, openWaarde: 0 });
    for (const a of activities) {
      const t = a.type;
      const u = ensure(a.user_id);
      if (acqKey && t === acqKey) u.gebeld += 1;
      else if (t === meetKey) u.afsprakenDoor += 1;
    }

    // ── Gewonnen deals (aantal + omzet per gebruiker, en per categorie) ───────
    // Categorie wordt afgeleid uit de DEAL-TITEL (afspraak met team: categorie
    // staat als trefwoord in de titel, bv. "Acme - Jobboost"). Zie categoryFromTitle.
    const wonDeals = await fetchDealsByTime(date, 'won_time');
    const perCategory = {}; // CCOboard-categorie -> omzet
    for (const d of wonDeals) {
      const val = Number(d.value) || 0;
      const ownerId = dealOwner(d);
      if (ownerId != null) { const u = ensure(ownerId); u.omzet += val; u.deals += 1; }

      const cat = categoryFromTitle(d.title);
      perCategory[cat] = (perCategory[cat] || 0) + val;
    }

    // ── Verloren deals (aantal per gebruiker) → win rate ──────────────────────
    const lostDeals = await fetchDealsByTime(date, 'lost_time');
    for (const d of lostDeals) { const ownerId = dealOwner(d); if (ownerId != null) ensure(ownerId).verloren += 1; }

    // ── Open pipeline (momentopname; niet datum-gebonden) ─────────────────────
    const openDeals = await fetchOpenDeals();
    for (const d of openDeals) {
      const ownerId = dealOwner(d);
      if (ownerId != null) { const u = ensure(ownerId); u.openDeals += 1; u.openWaarde += Number(d.value) || 0; }
    }

    // user_id -> naam, in array voor de frontend (die mapt op teamleden op naam)
    const perUserNamed = Object.entries(perUser).map(([uid, v]) => ({
      name: users[uid] || `#${uid}`,
      ...v
    }));

    return res.json({ date, perUser: perUserNamed, perCategory });
  } catch (err) {
    console.error('pipedrive-day', err);
    return res.status(502).json({ error: 'Pipedrive-fout: ' + err.message });
  }
};

// ── Pipedrive helpers ──────────────────────────────────────────────────────────
async function pd(path, params = {}) {
  const url = new URL(PD_BASE + path);
  url.searchParams.set('api_token', PD_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  const json = await r.json();
  if (json.success === false) throw new Error(`${path} → ${json.error || 'onbekend'}`);
  return json;
}

async function fetchUsers() {
  const { data } = await pd('/users');
  const map = {};
  (data || []).forEach(u => { map[u.id] = u.name; });
  return map;
}

async function fetchActivityTypes() {
  const { data } = await pd('/activityTypes');
  const map = {}; // naam(lowercase) -> key_string
  (data || []).forEach(t => { map[(t.name || '').toLowerCase()] = t.key_string; });
  return map;
}

// Categorie uit de deal-titel halen. Het team zet de categorie als trefwoord
// in de titel. Specifiekere categorieën eerst (nieuw/bestaand vóór generiek
// "abonnement"). Geen match → "Overig".
const CATEGORY_KEYWORDS = [
  ['Abonnement nieuw', ['abonnement nieuw', 'abo nieuw', 'abonnement-nieuw']],
  ['Abonnement bestaand', ['abonnement bestaand', 'abo bestaand', 'abonnement-bestaand', 'abonnement', 'abo']],
  ['Eenmalige plaatsing', ['eenmalige plaatsing', 'eenmalig', 'plaatsing']],
  ['Jobboost', ['jobboost', 'job boost', 'boost']],
  ['CPC', ['cpc']],
  ['Resellers', ['reseller']],
  ['CV Database', ['cv database', 'cv-database', 'cv db', 'cvdatabase', 'database']],
  ['Overig', ['overig']],
];

function categoryFromTitle(title) {
  const t = String(title || '').toLowerCase();
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'Overig';
}

async function fetchDoneActivitiesCompletedOn(date) {
  // Pipedrive's start_date/end_date filteren op due_date, niet op afrond-datum.
  // Een call kan eerder gepland zijn maar vandaag afgerond. We halen daarom een
  // ruim due-venster afgeronde activiteiten op (90 dagen terug t/m 7 dagen vooruit)
  // en houden alleen wat op `date` is afgerond (marked_as_done_time).
  const startWin = addDays(date, -90);
  const endWin = addDays(date, 8); // exclusief, dus t/m +7
  const out = [];
  let start = 0;
  for (let i = 0; i < 60; i++) {
    const json = await pd('/activities', {
      user_id: 0, done: 1, start_date: startWin, end_date: endWin, limit: 500, start
    });
    (json.data || []).forEach(a => {
      if ((a.marked_as_done_time || '').slice(0, 10) === date) out.push(a);
    });
    const pg = json.additional_data?.pagination;
    if (!pg?.more_items_in_collection) break;
    start = pg.next_start;
  }
  return out;
}

function nextDay(date) { return addDays(date, 1); }
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchDealsByTime(date, fieldKey) {
  const json = await pd('/deals/timeline', {
    start_date: date, interval: 'day', amount: 1, field_key: fieldKey, user_id: 0
  });
  const periods = json.data || [];
  const deals = [];
  periods.forEach(p => (p.deals || []).forEach(d => deals.push(d)));
  return deals;
}

async function fetchOpenDeals() {
  const out = [];
  let start = 0;
  for (let i = 0; i < 40; i++) {
    const json = await pd('/deals', { status: 'open', user_id: 0, limit: 500, start });
    (json.data || []).forEach(d => out.push(d));
    const pg = json.additional_data?.pagination;
    if (!pg?.more_items_in_collection) break;
    start = pg.next_start;
  }
  return out;
}

function dealOwner(d) {
  return typeof d.user_id === 'object' ? d.user_id?.id : d.user_id;
}
