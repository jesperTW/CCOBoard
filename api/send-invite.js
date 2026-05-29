const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify the request comes from an authenticated user
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Ongeldig e-mailadres' });

  try {
    // Generate invite link via Supabase
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { redirectTo: 'https://ccoboard.nl/' }
    });
    if (linkError) throw linkError;

    const inviteUrl = linkData.properties?.action_link;

    // Send branded invite email via Resend
    const { error: sendError } = await resend.emails.send({
      from: 'CCO Board <noreply@ccoboard.nl>',
      to: email,
      subject: 'Je bent uitgenodigd voor CCO Board',
      html: buildInviteHTML({ inviterEmail: user.email, inviteUrl })
    });

    if (sendError) throw sendError;

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

function buildInviteHTML({ inviterEmail, inviteUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#f4f6fb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(13,27,94,.08)">
  <tr><td style="background:#0d1b5e;padding:28px 32px;text-align:center">
    <span style="background:#3b6af5;color:#fff;font-weight:900;font-size:20px;padding:10px 16px;border-radius:10px">C</span>
    <h1 style="color:#fff;font-size:20px;font-weight:800;margin:16px 0 4px">CCO Board</h1>
    <p style="color:rgba(255,255,255,.5);font-size:13px;margin:0">Techniekwerkt dashboard</p>
  </td></tr>
  <tr><td style="padding:36px 32px">
    <h2 style="color:#0d1b5e;font-size:22px;font-weight:800;margin:0 0 12px">Je bent uitgenodigd!</h2>
    <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 24px"><strong style="color:#0d1b5e">${inviterEmail}</strong> heeft je uitgenodigd om toegang te krijgen tot het CCO Board dashboard van Techniekwerkt.</p>
    <div style="text-align:center;margin:32px 0">
      <a href="${inviteUrl}" style="display:inline-block;background:#3b6af5;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700">Uitnodiging accepteren</a>
    </div>
    <p style="color:#9ca3af;font-size:12px;line-height:1.6;margin:0">Deze link is 24 uur geldig. Als je deze e-mail niet verwachtte, kun je hem veilig negeren.</p>
  </td></tr>
  <tr><td style="background:#f4f6fb;padding:16px 32px;border-top:1px solid #e5e7ef">
    <p style="font-size:11px;color:#9ca3af;margin:0;text-align:center">CCO Board · <a href="https://ccoboard.nl" style="color:#3b6af5;text-decoration:none">ccoboard.nl</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
