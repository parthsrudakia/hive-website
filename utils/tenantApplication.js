// Finalization of the paid tenant application, shared by the Checkout return
// page (routes/public.js) and the checkout.session.completed webhook
// (routes/stripeWebhook.js). Whichever fires first wins; the guarded UPDATE
// makes the other a no-op, so confirmation emails are only ever sent once.
const pool = require('../db/pool');
const { sendMail, confirmationHtml, NOTIFY_EMAIL } = require('./mailer');
const { completeApplication } = require('./portalApplications');
const { SITE_URL } = require('./seo');

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
            amount_cents = COALESCE($3, amount_cents),
            -- Invite applications queue the portal agreement (see below).
            agreement_status = CASE WHEN invite_token IS NOT NULL THEN 'pending' ELSE agreement_status END
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
    // Permanent links to the applicant's photo IDs. They point at the admin
    // route (login required), which mints a fresh signed URL on every click,
    // so the links in this email never expire and the IDs stay private.
    const idLink = (side) => `${SITE_URL}/admin/paid-applications/${app.id}/id/${side}`;
    const idCell = (path, side) => path ? `<a href="${idLink(side)}" style="color:#d4920b;">View (admin login required)</a>` : 'Not provided';
    const docsCell = (Array.isArray(a.income_docs) ? a.income_docs : [])
      .map((doc, i) => `<a href="${SITE_URL}/admin/paid-applications/${app.id}/doc/${i}" style="color:#d4920b;">${escapeHtml(doc.name || `Document ${i + 1}`)}</a>`)
      .join('<br>');
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
          ${row('Photo ID — Front', idCell(a.id_front_path, 'front'))}
          ${row('Photo ID — Back', idCell(a.id_back_path, 'back'))}
          ${row('Bank Statements / Pay Stubs', docsCell)}
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

// ---------------------------------------------------------------------------
// Agreement for invite applications. Once the fee is paid, the portal is told
// about the applicant (utils/portalApplications.js) and sends the agreement.
// agreement_status: 'pending' (queued or retrying), 'sending' (claimed by one
// run), 'sent', or 'failed' (the portal refused; shown in admin). Runs after
// every finalize, from the daily cron and from the admin Retry button.

// A claim older than this is treated as a crashed run and taken over.
const STALE_CLAIM = "INTERVAL '5 minutes'";

const FAILURE_REASONS = {
  expired: 'Invite expired: send the agreement from the portal by hand.',
  cancelled: 'Invite was cancelled in the portal.',
  used: 'Invite was already used by another application.',
  not_found: 'Invite not found in the portal.',
  invalid_dates: 'Portal rejected the lease dates',
  invalid_request: 'Portal rejected the request',
  missing_data: 'Application has no invite or lease dates.'
};

function failureReason(result) {
  const base = FAILURE_REASONS[result.status] || 'Portal refused the application';
  return result.error && !base.endsWith('.') ? `${base}: ${result.error}` : base;
}

// Takes one application for sending. Only one run can hold it, so the Stripe
// webhook and the return page never both call the portal.
async function claimAgreement(id) {
  const { rows } = await pool.query(
    `UPDATE tenant_applications
        SET agreement_status = 'sending', agreement_claimed_at = NOW()
      WHERE id = $1
        AND payment_status = 'paid'
        AND (agreement_status = 'pending'
             OR (agreement_status = 'sending' AND agreement_claimed_at < NOW() - ${STALE_CLAIM}))
      RETURNING id, full_name, email, phone, invite_token,
                to_char(lease_start, 'YYYY-MM-DD') AS lease_start,
                to_char(lease_end, 'YYYY-MM-DD') AS lease_end`,
    [id]
  );
  return rows[0] || null;
}

async function sendOneAgreement(app) {
  if (!app.invite_token || !app.lease_start || !app.lease_end) {
    return { outcome: 'failed', status: 'missing_data', error: null };
  }
  try {
    return await completeApplication({
      token: app.invite_token,
      full_name: app.full_name,
      email: app.email,
      phone: app.phone,
      start_date: app.lease_start,
      end_date: app.lease_end,
      website_application_id: app.id
    });
  } catch (err) {
    return { outcome: 'retry', status: 'error', error: err.message };
  }
}

async function recordAgreementResult(id, result) {
  if (result.outcome === 'sent') {
    await pool.query(
      `UPDATE tenant_applications
          SET agreement_status = 'sent', agreement_request_id = $2, agreement_email_differs = $3,
              agreement_sent_at = COALESCE(agreement_sent_at, NOW()), agreement_error = NULL,
              agreement_attempts = agreement_attempts + 1, agreement_claimed_at = NULL
        WHERE id = $1`,
      [id, result.agreementRequestId, !!result.emailDiffers]
    );
    return;
  }
  const failed = result.outcome === 'failed';
  await pool.query(
    `UPDATE tenant_applications
        SET agreement_status = $2, agreement_error = $3,
            agreement_attempts = agreement_attempts + 1, agreement_claimed_at = NULL
      WHERE id = $1`,
    [id, failed ? 'failed' : 'pending', (failed ? failureReason(result) : result.error || 'Portal call failed').slice(0, 500)]
  );
}

// Sends the agreement for up to `limit` queued applications. onlyId limits
// the run to one application (admin Retry); preferSessionId puts the
// application just paid first. No new portal call starts once budgetMs has
// passed. Errors on one row are logged and never stop the others.
async function processPendingAgreements({ onlyId = null, preferSessionId = null, limit = 3, budgetMs = 10000 } = {}) {
  const started = Date.now();
  const summary = { processed: 0, sent: 0, retry: 0, failed: 0 };
  const { rows } = await pool.query(
    `SELECT id FROM tenant_applications
      WHERE payment_status = 'paid'
        AND ($1::int IS NULL OR id = $1::int)
        AND (agreement_status = 'pending'
             OR (agreement_status = 'sending' AND agreement_claimed_at < NOW() - ${STALE_CLAIM}))
      ORDER BY COALESCE(stripe_session_id = $2, false) DESC, paid_at ASC NULLS LAST, id ASC
      LIMIT $3`,
    [onlyId, preferSessionId, limit]
  );
  for (const { id } of rows) {
    if (summary.processed > 0 && Date.now() - started > budgetMs) break;
    try {
      const app = await claimAgreement(id);
      if (!app) continue; // another run has it
      summary.processed++;
      const result = await sendOneAgreement(app);
      await recordAgreementResult(id, result);
      summary[result.outcome]++;
      if (result.outcome !== 'sent') {
        console.warn(`[agreements] Application #${id}: ${result.outcome} (${result.status}) ${result.error || ''}`.trim());
      }
    } catch (err) {
      console.error(`[agreements] Application #${id} error:`, err.message);
    }
  }
  return summary;
}

// What both finalize callers run on every call (first or repeat), so a page
// refresh or a webhook retry also retries a pending agreement. Never throws.
async function sendAgreementsAfterPayment(session) {
  try {
    return await processPendingAgreements({ preferSessionId: (session && session.id) || null, limit: 3, budgetMs: 10000 });
  } catch (err) {
    console.error('[agreements] After-payment run failed:', err.message);
    return null;
  }
}

module.exports = { finalizePaidApplication, processPendingAgreements, sendAgreementsAfterPayment };
