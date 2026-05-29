const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Vaste ontvangers uit env var, bijv: "jesper@techniekwerkt.nl,michiel@techniekwerkt.nl"
  const recipients = (process.env.REPORT_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!recipients.length) return res.status(400).json({ error: 'Geen ontvangers ingesteld (REPORT_RECIPIENTS)' });

  try {
    // Haal de eerste rij op met dashboard data (gedeeld teamdashboard)
    const { data: row, error: dataError } = await supabase
      .from('dashboard_data')
      .select('data')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (dataError) throw dataError;
    if (!row?.data) return res.json({ success: true, message: 'Geen data gevonden' });

    const results = [];
    {
      const S = row.data;
      const now = new Date();
      const monday = getMonday(now);
      const weekDays = Array.from({ length: 5 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        return d.toISOString().split('T')[0];
      });

      const weekData = weekDays.map(date => ({
        date,
        day: S.days?.find(d => d.datum === date) || null
      }));

      const tG = weekData.reduce((s, x) => s + (x.day?.gebeld || 0), 0);
      const tA = weekData.reduce((s, x) => s + (x.day?.afspraken || 0), 0);
      const tO = weekData.reduce((s, x) => s + dayOmzet(x.day), 0);
      const totOmzet = totalOmzet(S);
      const doel = S.doel || 1000000;
      const pct = ((totOmzet / doel) * 100).toFixed(1).replace('.', ',');

      const weekNum = getWeekNumber(monday);
      const startLabel = monday.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
      const endDate = new Date(monday); endDate.setDate(endDate.getDate() + 4);
      const endLabel = endDate.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

      const html = buildEmailHTML({ S, weekNum, startLabel, endLabel, tG, tA, tO, totOmzet, doel, pct, weekData });

      for (const to of recipients) {
        const { error: sendError } = await resend.emails.send({
          from: `CCO Board <weekrapport@ccoboard.nl>`,
          to,
          subject: `Weekrapport week ${weekNum} — ${S.bedrijf || 'CCO Board'}`,
          html
        });
        results.push({ email: to, sent: !sendError, error: sendError?.message });
      }
    }

    return res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
  dt.setDate(diff);
  return dt;
}

function getWeekNumber(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dn = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dn);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - ys) / 86400000) + 1) / 7);
}

function dayOmzet(d) {
  return d?.cats ? Object.values(d.cats).reduce((a, b) => a + (b || 0), 0) : 0;
}

function totalOmzet(S) {
  const startSum = Object.values(S.startCats || {}).reduce((a, b) => a + (b || 0), 0);
  const year = new Date().getFullYear().toString();
  return startSum + (S.days || [])
    .filter(d => (d.datum || '').startsWith(year))
    .reduce((s, d) => s + dayOmzet(d), 0);
}

function fmt(n) { return Math.round(n || 0).toLocaleString('nl-NL'); }

function buildEmailHTML({ S, weekNum, startLabel, endLabel, tG, tA, tO, totOmzet, doel, pct, weekData }) {
  const memberRows = (S.members || []).map(m => {
    const mk = m.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const g = weekData.reduce((s, x) => s + (x.day?.team?.[mk]?.gebeld || 0), 0);
    const a = weekData.reduce((s, x) => s + (x.day?.team?.[mk]?.afspraken || 0), 0);
    const o = weekData.reduce((s, x) => s + (x.day?.team?.[mk]?.omzet || 0), 0);
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef">${m}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef;text-align:right">${g}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef;text-align:right">${a}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef;text-align:right;font-weight:700">€${fmt(o)}</td></tr>`;
  }).join('');

  const dagRows = weekData.filter(x => x.day).map(({ date, day }) => {
    const ds = new Date(date + 'T12:00:00').toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'short' });
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef">${ds}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef;text-align:right">${day.gebeld || 0}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef;text-align:right">${day.afspraken || 0}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7ef;text-align:right;font-weight:700">€${fmt(dayOmzet(day))}</td></tr>`;
  }).join('') || `<tr><td colspan="4" style="padding:12px;color:#6b7280;text-align:center">Geen registraties deze week</td></tr>`;

  const barWidth = Math.min((totOmzet / doel) * 100, 100).toFixed(1);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#f4f6fb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(13,27,94,.08)">
  <tr><td style="background:#0d1b5e;padding:28px 32px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="display:inline-flex;align-items:center;gap:10px"><span style="background:#3b6af5;color:#fff;font-weight:900;font-size:18px;padding:8px 14px;border-radius:8px">C</span></div></td>
      <td align="right"><span style="color:#fff;font-size:18px;font-weight:700">${S.bedrijf || 'Techniekwerkt'}</span><br/><span style="color:rgba(255,255,255,.5);font-size:12px">Weekrapport week ${weekNum}</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 32px 16px">
    <p style="color:#6b7280;font-size:14px;margin:0 0 4px">${startLabel} t/m ${endLabel}</p>
    <h2 style="color:#0d1b5e;font-size:22px;font-weight:800;margin:0 0 20px">Week ${weekNum} overzicht</h2>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="33%" style="background:#f4f6fb;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:26px;font-weight:800;color:#0d1b5e">${fmt(tG)}</div>
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Gebeld</div>
        </td>
        <td width="4%"></td>
        <td width="33%" style="background:#f4f6fb;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:26px;font-weight:800;color:#0d1b5e">${fmt(tA)}</div>
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Afspraken</div>
        </td>
        <td width="4%"></td>
        <td width="33%" style="background:#3b6af5;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:26px;font-weight:800;color:#fff">€${fmt(tO)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.7);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Omzet week</div>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 24px">
    <p style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Voortgang jaardoel — €${fmt(totOmzet)} / €${fmt(doel)} (${pct}%)</p>
    <div style="background:#e5e7ef;border-radius:20px;height:10px;overflow:hidden">
      <div style="background:linear-gradient(90deg,#3b6af5,#4db8f0);height:100%;width:${barWidth}%;border-radius:20px"></div>
    </div>
  </td></tr>
  <tr><td style="padding:0 32px 24px">
    <p style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:0 0 10px">Per dag</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7ef;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#0d1b5e"><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:left">Dag</th><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:right">Gebeld</th><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:right">Afspraken</th><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:right">Omzet</th></tr></thead>
      <tbody>${dagRows}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 32px">
    <p style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:0 0 10px">Team</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7ef;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#0d1b5e"><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:left">Naam</th><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:right">Gebeld</th><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:right">Afspraken</th><th style="padding:8px 12px;color:#fff;font-size:11px;text-align:right">Omzet</th></tr></thead>
      <tbody>${memberRows}</tbody>
    </table>
  </td></tr>
  <tr><td style="background:#f4f6fb;padding:16px 32px;border-top:1px solid #e5e7ef">
    <p style="font-size:11px;color:#9ca3af;margin:0;text-align:center">CCO Board · <a href="https://ccoboard.nl" style="color:#3b6af5;text-decoration:none">ccoboard.nl</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
