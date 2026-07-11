// Finalization of the paid tenant application, shared by the Checkout return
// page (routes/public.js) and the checkout.session.completed webhook
// (routes/stripeWebhook.js). Whichever fires first wins; the guarded UPDATE
// makes the other a no-op, so confirmation emails are only ever sent once.
const pool = require('../db/pool');
const { sendMail, confirmationHtml, NOTIFY_EMAIL } = require('./mailer');
const { signedPrivateUrl } = require('./storage');

// Marks the application matching this Checkout Session as paid and sends the
// notification + applicant-confirmation emails. Returns the finalized row, or
// null when the session isn't paid or the row was already finalized.
async function finalizePaidApplication(session) {
  if (!session || session.payment_status !== 'paid') return null;

  const { rows } = await pool.query(
    `UPDATE tenant_applications
        SET payment_status = 'paid',
            paid_at = NOW(),
            stripe_payment_intent = $1,
            amount_cents = COALESCE($3, amount_cents)
      WHERE stripe_session_id = $2 AND payment_status <> 'paid'
      RETURNING id, full_name, email, phone, answers, identity_status`,
    [
      session.payment_intent || null,
      session.id,
      // Adaptive Pricing can settle in another currency; only trust the total
      // when it's actually USD cents.
      session.currency === 'usd' ? session.amount_total : null
    ]
  );
  if (rows.length === 0) return null;

  const app = rows[0];
  const feeCents = (session.currency === 'usd' && session.amount_total)
    ? session.amount_total
    : parseInt(process.env.APPLICATION_FEE_CENTS || '2000', 10);

  // Notify the master inbox (best-effort — the row is already finalized).
  try {
    const a = app.answers || {};
    const row = (label, value) => `<tr><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;width:200px;">${label}</td><td style="padding:10px;border-bottom:1px solid #eee;">${value || 'Not provided'}</td></tr>`;
    // Short-lived signed links so the admin can view the photo IDs (private bucket).
    const frontLink = await signedPrivateUrl(a.id_front_path).catch(() => null);
    const backLink = await signedPrivateUrl(a.id_back_path).catch(() => null);
    const idCell = (url) => url ? `<a href="${url}" style="color:#d4920b;">View (link valid 7 days)</a>` : 'Uploaded (open in admin)';
    await sendMail({
      to: NOTIFY_EMAIL,
      replyTo: app.email,
      subject: `New PAID Hive Application: ${app.full_name}`,
      html: `
        <h2>New Tenant Application (Paid — $${(feeCents / 100).toFixed(2)})</h2>
        <table style="border-collapse:collapse;width:100%;max-width:600px;">
          ${row('First Name', a.first_name)}
          ${row('Last Name', a.last_name)}
          ${row('Email', app.email)}
          ${row('Phone', app.phone)}
          ${row('Birthdate', a.birthdate)}
          ${row('SSN (last 4)', a.ssn_last4 ? `***-**-${a.ssn_last4}` : null)}
          ${row('LinkedIn / Instagram', a.social_profile ? `<a href="${a.social_profile.startsWith('http') ? a.social_profile : 'https://' + a.social_profile}" style="color:#d4920b;">${a.social_profile}</a>` : null)}
          ${row('Photo ID — Front', idCell(frontLink))}
          ${row('Photo ID — Back', idCell(backLink))}
          ${row('Emergency Contact', a.emergency_contact_name)}
          ${row('Emergency — Phone', a.emergency_contact_phone)}
          ${row('Emergency — Email', a.emergency_contact_email)}
          ${row('Emergency — Relationship', a.emergency_contact_relationship)}
        </table>
        <p style="margin-top:20px;color:#888;font-size:12px;">Payment confirmed via Stripe · Application #${app.id} · Stripe Identity verification pending (you'll get a follow-up email with the result)</p>`
    });
  } catch (mailErr) {
    console.error('[mail] Failed to send paid-application notification:', mailErr.message);
  }

  // Confirmation to the applicant (best-effort).
  try {
    await sendMail({
      to: app.email,
      subject: 'We received your Hive application',
      html: confirmationHtml(`Thanks for applying, ${app.full_name}!`, [
        `We have received your application and your $${(feeCents / 100).toFixed(2)} application fee.`,
        'One step remains: a quick identity verification, handled securely by Stripe Identity. Use the "Verify My Identity" button on the confirmation page (you\'ll need your government ID and a device with a camera).',
        'After that, our team will review your application and reach out with next steps.',
        'In the meantime, feel free to browse our latest listings at <a href="https://hiveny.com/properties" style="color: #d4920b;">hiveny.com/properties</a>.'
      ])
    });
  } catch (mailErr) {
    console.error('[mail] Failed to send applicant confirmation:', mailErr.message);
  }

  return app;
}

module.exports = { finalizePaidApplication };
