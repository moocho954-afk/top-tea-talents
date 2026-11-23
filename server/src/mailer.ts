// TOP TEA TALENTS — Gmail transport (v1.3.0). Bun + TypeScript, ZERO npm
// dependencies: plain fetch() against the Gmail API, no nodemailer, no SMTP
// library. Credentials come ONLY from environment (Render dashboard):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// The sender address comes from the DB setting `agency_email`
// (default moocho954@gmail.com) — never from here, never hardcoded.
// If any credential is missing, mailStatus().configured is false and the
// drain leaves mail QUEUED with an honest reason. NOTHING is ever claimed
// sent when it was not: a send returns a Gmail message id, or throws.
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export function mailStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.GMAIL_CLIENT_ID) missing.push("GMAIL_CLIENT_ID");
  if (!process.env.GMAIL_CLIENT_SECRET) missing.push("GMAIL_CLIENT_SECRET");
  if (!process.env.GMAIL_REFRESH_TOKEN) missing.push("GMAIL_REFRESH_TOKEN");
  return { configured: missing.length === 0, missing };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
  const st = mailStatus();
  if (!st.configured) throw new Error("mail not configured — missing: " + st.missing.join(", "));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  if (!data.access_token) throw new Error("Gmail token refresh returned no access_token");
  cachedToken = { token: String(data.access_token), expiresAt: now + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

function cleanHeader(v: string): string {
  return String(v || "").replace(/[\r\n]+/g, " ").trim();
}

export interface SendMailOpts {
  from: string;
  to: string;
  cc?: string[];
  replyTo?: string[];
  subject: string;
  body: string;
}

export async function sendGmail(o: SendMailOpts): Promise<{ messageId: string }> {
  const st = mailStatus();
  if (!st.configured) throw new Error("mail not configured — missing: " + st.missing.join(", "));
  const to = cleanHeader(o.to);
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("invalid destination address: " + to);
  const lines: string[] = [
    `From: ${cleanHeader(o.from)}`,
    `To: ${to}`,
  ];
  const cc = (o.cc || []).map(cleanHeader).filter(Boolean);
  if (cc.length) lines.push(`Cc: ${cc.join(", ")}`);
  const rt = (o.replyTo || []).map(cleanHeader).filter(Boolean);
  if (rt.length) lines.push(`Reply-To: ${rt.join(", ")}`);
  lines.push(`Subject: ${cleanHeader(o.subject)}`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`, ``, String(o.body || ""));
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const token = await getAccessToken();
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  if (!data.id) throw new Error("Gmail send returned no message id");
  return { messageId: String(data.id) };
}

// First email address in free text (submission instructions, contact
// fields). Returns null when the text carries no address — the caller
// must then prepare the package instead of claiming a send.
export function extractEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}
