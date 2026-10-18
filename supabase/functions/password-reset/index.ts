// password-reset — self-service reset. Public (no JWT). Mints a recovery token via the admin API
// and emails a reset link through Brevo. The app verifies the token itself (verifyOtp), so this
// needs no Supabase Auth Site-URL/SMTP configuration. Always returns ok (no account enumeration).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const APP_URL = "https://aji-parent-hub.vercel.app";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const body = await req.json().catch(() => ({}));
    const email = (body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ ok: true });
    try {
      const { data, error } = await svc.auth.admin.generateLink({ type: "recovery", email });
      const hashed = data?.properties?.hashed_token;
      if (error || !hashed) return json({ ok: true }); // user may not exist — stay silent
      const link = `${APP_URL}/?token_hash=${hashed}&type=recovery`;
      let name = "there";
      try { if (data?.user?.id) { const { data: p } = await svc.from("profiles").select("full_name").eq("id", data.user.id).single(); if (p?.full_name) name = p.full_name.split(" ")[0]; } } catch { /* ignore */ }
      const { data: cfgRows } = await svc.from("app_config").select("key,value");
      const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
      if (cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING") {
        const htmlContent = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:auto;color:#1B2438">
          <h2 style="color:#14294D">Reset your Parent Hub password</h2>
          <p>Assalamu alaikum ${name},</p>
          <p>We received a request to reset the password for your Al Jamiatul Islamiyah Parent Hub account. Tap the button below to choose a new password.</p>
          <p style="margin:24px 0"><a href="${link}" style="background:#14294D;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">Set a new password</a></p>
          <p style="font-size:12px;color:#6E6A60">If the button doesn't work, copy and paste this link into your browser:<br/><a href="${link}">${link}</a></p>
          <p style="font-size:12px;color:#6E6A60">This link will expire shortly. If you didn't request this, you can ignore this email — your password won't change.</p>
          <hr style="border:none;border-top:1px solid #E8E3D6"/>
          <p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>`;
        await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name || "Parent Hub", email: cfg.brevo_sender_email }, to: [{ email }], subject: "Reset your Parent Hub password", htmlContent }) });
      }
    } catch { /* stay silent */ }
    return json({ ok: true });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
