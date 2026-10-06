// resend-login — admin-only. For each email: reset the parent's password to a fresh one and email it the login.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const WORDS = ["Noor", "Iman", "Sabr", "Huda", "Rahma", "Barakah", "Falah", "Amanah", "Hikmah", "Taqwa", "Nur", "Shukr"];
function newPass() { return WORDS[Math.floor(Math.random() * WORDS.length)] + Math.floor(1000 + Math.random() * 9000); }
function loginEmail(email: string, pass: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1B2438;font-size:15px;line-height:1.6">
<div style="background:#14294D;color:#fff;padding:16px 18px;border-radius:12px 12px 0 0"><span style="font-family:Georgia,serif;font-size:19px;font-weight:bold">Your Parent Hub login</span><br><span style="color:#C9D3E6;font-size:13px">Al Jamiatul Islamiyah · Bolton Darul Uloom</span></div>
<div style="border:1px solid #E4DECF;border-top:none;border-radius:0 0 12px 12px;padding:18px">
<p><b>Assalāmu ʿalaykum wa raḥmatullāh,</b></p>
<p>Here are your login details for the <b>Parent Hub</b> — our app for school messages, newsletters, attendance alerts and more. It replaces the need for WhatsApp and is completely private to you.</p>
<table style="border-collapse:collapse;margin:10px 0;background:#FAF8F3;border:1px solid #E8E3D6;border-radius:8px;width:100%">
<tr><td style="padding:10px 14px;color:#6E6A60;width:90px">Website</td><td style="padding:10px 14px"><a href="https://aji-parent-hub.vercel.app" style="color:#14294D;font-weight:bold">aji-parent-hub.vercel.app</a></td></tr>
<tr><td style="padding:10px 14px;color:#6E6A60;border-top:1px solid #E8E3D6">Email</td><td style="padding:10px 14px;border-top:1px solid #E8E3D6"><b>${email}</b></td></tr>
<tr><td style="padding:10px 14px;color:#6E6A60;border-top:1px solid #E8E3D6">Password</td><td style="padding:10px 14px;border-top:1px solid #E8E3D6"><b style="font-size:17px;letter-spacing:.5px">${pass}</b></td></tr>
</table>
<p><b>To sign in:</b></p>
<ol style="margin:4px 0 12px;padding-left:20px"><li>Open <b>aji-parent-hub.vercel.app</b></li><li>Enter the email and password above</li><li>Tap <b>Enable</b> on the Notifications card to get instant alerts</li></ol>
<p style="background:#F3F1E8;border-radius:8px;padding:10px 12px;margin:10px 0"><b>📱 iPhone users:</b> in Safari, tap <b>Share → Add to Home Screen</b> first, then open the app from that icon and tap Enable (Apple only allows notifications that way).</p>
<p style="color:#6E6A60;font-size:13px">If this email landed in your <b>Junk/Spam</b> folder, please mark it “Not Junk” and add our address to your contacts so future messages reach you. Any trouble signing in, just reply to this email.</p>
<p style="margin-top:14px">JazākumAllāhu khayran,<br><b style="color:#14294D">Al Jamiatul Islamiyah — Bolton Darul Uloom</b></p>
</div></div>`;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    if (!me || me.role !== "admin") return json({ error: "admins only" }, 403);
    const body = await req.json();
    const emails: string[] = Array.isArray(body.emails) ? body.emails : [];
    const dryRun = !!body.dry_run;
    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
    const results: any[] = [];
    for (const email of emails) {
      const { data: prof } = await svc.from("profiles").select("id,full_name,email").eq("email", email).maybeSingle();
      if (!prof) { results.push({ email, status: "no_account" }); continue; }
      if (dryRun) { results.push({ email, status: "would_send", name: prof.full_name }); continue; }
      const pass = newPass();
      const { error: ue } = await svc.auth.admin.updateUserById(prof.id, { password: pass });
      if (ue) { results.push({ email, status: "reset_failed", error: ue.message }); continue; }
      let emailStatus = "reset_only";
      try {
        const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name || "Al Jamiatul Islamiyah", email: cfg.brevo_sender_email }, to: [{ email: prof.email, name: prof.full_name }], subject: "Your Parent Hub login — Al Jamiatul Islamiyah", htmlContent: loginEmail(prof.email, pass) }) });
        emailStatus = r.ok ? "sent" : "email_failed";
      } catch (_) { emailStatus = "email_failed"; }
      results.push({ email, name: prof.full_name, password: pass, status: emailStatus });
    }
    return json({ ok: true, count: results.length, results });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
