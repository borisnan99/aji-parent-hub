// add-parent — admin adds an additional parent email to a child.
// Creates the parent account (service role), links the child, and emails the invite immediately.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

function tempPassword(email: string) {
  const base = (email.split("@")[0].replace(/[^a-zA-Z]/g, "") || "Parent");
  const cap = base.charAt(0).toUpperCase() + base.slice(1, 6).toLowerCase();
  return cap + Math.floor(1000 + Math.random() * 9000);
}

function inviteHtml(em: string, pw: string, child: string) {
  const NAVY = "#14294D", GOLD = "#C4A24C", CREAM = "#FAF8F3";
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1B2438;max-width:600px;margin:0 auto;font-size:15px;line-height:1.6">
<div style="background:${NAVY};color:#fff;padding:18px 20px;border-radius:12px 12px 0 0"><span style="font-family:Georgia,serif;font-size:20px;font-weight:bold">Parent Hub</span><br><span style="color:#C9D3E6;font-size:13px">Al Jamiatul Islamiyah · Bolton Darul Uloom</span></div>
<div style="border:1px solid #E4DECF;border-top:none;border-radius:0 0 12px 12px;padding:20px">
<p><b>Assalāmu ʿalaykum wa raḥmatullāh,</b></p>
<p>You've been added to <b>Parent Hub</b> — the school's own app to stay connected with ${child ? child + "'s" : "your son's"} attendance, messages and school notices, all in one place on your phone. It's free and private.</p>
<div style="background:${CREAM};border:1px solid #E4DECF;border-radius:10px;padding:14px 16px;margin:16px 0">
  <div style="font-weight:bold;color:${NAVY};margin-bottom:6px">Your login</div>
  <div>🌐 Website: <a href="https://aji-parent-hub.vercel.app" style="color:${NAVY};font-weight:bold">aji-parent-hub.vercel.app</a></div>
  <div>✉️ Email: <b>${em}</b></div>
  <div>🔑 Password: <b>${pw}</b></div>
</div>
<div style="font-weight:bold;color:${NAVY}">Getting started (2 minutes)</div>
<ol style="padding-left:20px;margin:6px 0 14px">
  <li>Open the link above (Chrome works best) and sign in with the details above.</li>
  <li>Add it to your home screen so it opens like an app — if a security prompt appears, that's normal, just tap <b>Install / Add</b>.</li>
  <li>Tap <b>Enable</b> to turn on notifications — this is how you'll get instant alerts.</li>
</ol>
<p>We're just beginning, so please bear with us — inshāʾAllāh a great benefit. If you have any trouble signing in, please contact the school office.</p>
<p style="text-align:center;font-style:italic;color:${NAVY};margin-top:18px">JazākumAllāhu khayran.</p>
<p style="text-align:center;color:#6E6A60;font-size:13px;margin-top:4px">With du'ās,<br><b style="color:${NAVY}">Maulana Luqman Amla</b><br>Principal</p>
</div></div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    const { data: acc } = await svc.from("staff_access").select("is_full").eq("user_id", user.id).maybeSingle();
    if (!me || (me.role !== "admin" && !(acc && acc.is_full))) return json({ error: "admins only" }, 403);

    let { pupil_id, email, name } = await req.json();
    email = (email || "").trim().toLowerCase();
    if (!pupil_id || !email || !email.includes("@")) return json({ error: "pupil_id and a valid email are required" }, 400);

    const { data: pupil } = await svc.from("pupils").select("id,first_name,last_name").eq("id", pupil_id).single();
    if (!pupil) return json({ error: "pupil not found" }, 404);
    const childName = `${pupil.first_name} ${pupil.last_name}`.trim();

    // does a profile with this email already exist?
    const { data: existing } = await svc.from("profiles").select("id,role,full_name").eq("email", email).maybeSingle();
    let parentId: string, created = false, pw = "";

    if (existing) {
      parentId = existing.id;
      // ensure they're a parent
      if (existing.role !== "parent") return json({ error: "That email already belongs to a staff account" }, 409);
    } else {
      pw = tempPassword(email);
      const { data: made, error: cErr } = await svc.auth.admin.createUser({
        email, password: pw, email_confirm: true, user_metadata: { full_name: name || "" },
      });
      if (cErr || !made?.user) return json({ error: "could not create account: " + (cErr?.message || "unknown") }, 500);
      parentId = made.user.id;
      created = true;
      await svc.from("profiles").upsert({ id: parentId, role: "parent", full_name: name || email.split("@")[0], email, is_active: true });
      await svc.from("parent_preferences").upsert({ parent_id: parentId, email_opt_in: true });
    }

    // link to the child (not primary — the first parent stays preferred)
    await svc.from("parent_pupil").upsert(
      { parent_id: parentId, pupil_id, relationship: "guardian", is_primary: false },
      { onConflict: "parent_id,pupil_id", ignoreDuplicates: true },
    );

    // send the invite (only meaningful when we just created + have the password)
    let emailed = false;
    if (created) {
      const { data: cfgRows } = await svc.from("app_config").select("key,value");
      const cfg: Record<string, string> = {};
      (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
      const brevo = cfg.brevo_api_key, sender = cfg.brevo_sender_email || "luqman.amla@boltondarululoom.org.uk";
      if (brevo) {
        const r = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": brevo, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: { name: "Al Jamiatul Islamiyah", email: sender },
            to: [{ email, name: name || "" }], replyTo: { email: sender },
            subject: "Your Parent Hub login — Al Jamiatul Islamiyah",
            htmlContent: inviteHtml(email, pw, childName),
          }),
        });
        emailed = r.ok;
      }
    }
    return json({ ok: true, created, emailed, email, parent_id: parentId, child: childName });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
