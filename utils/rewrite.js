// "Rewrite with AI" for admin replies to applicants (Applications tab popup).
// Uses the official Anthropic SDK; the client resolves credentials from
// ANTHROPIC_API_KEY (or a local `ant auth login` profile in development).
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.REWRITE_MODEL || 'claude-sonnet-5';

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function rewriteEnabled() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `You polish draft emails written by the Hive team (Hive rents furnished, flexible-lease apartments in New York City, Jersey City, and Hoboken) to people who applied to rent with Hive.

Rewrite the draft so it reads as a warm, clear, professional email reply from Hive to the applicant.

Rules:
- Keep every fact, date, number, price, question, and commitment in the draft. Do not invent details, offers, availability, or next steps that are not in the draft.
- Keep it about the same length as the draft. Tighten wording; do not pad.
- Plain text only: no markdown, no bullet symbols unless the draft already uses a list, no subject line.
- Do not add a greeting or sign-off unless the draft already has one. The email template adds the signature.
- Use plain punctuation: commas, periods, and colons. Never use em dashes or en dashes.
- Keep the writer's tone and first person voice. American English.
- Output only the rewritten email body, nothing else.`;

// Returns the rewritten text. Throws with a user-safe message on failure.
async function rewriteReply({ message, applicantName, property }) {
  const draft = String(message || '').trim();
  if (!draft) throw new Error('Nothing to rewrite.');

  const context = [];
  if (applicantName) context.push(`Applicant's name: ${applicantName}`);
  if (property) context.push(`Property they asked about: ${property}`);

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `${context.length ? context.join('\n') + '\n\n' : ''}Draft to rewrite:\n<draft>\n${draft}\n</draft>`
    }]
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The AI declined to rewrite this message. Please edit it by hand.');
  }
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('The AI returned an empty rewrite. Please try again.');
  return text;
}

module.exports = { rewriteReply, rewriteEnabled, MODEL };
