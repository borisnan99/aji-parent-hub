// report-incident — log a pupil injury/incident and notify the parents (in-app message + email + push).
// Access: admins, plus the named safeguarding staff (Gulfam Khan, Imteyaz Omarji, Yasin Patel).
// Actions: create (log + notify), list (recent incident log).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

// NOTE: verify these against the live profiles table once the AJI Supabase is reconnected.
const INCIDENT_NAMES = ["luqman amla", "mohammed atcha", "gulfam khan", "imteyaz omarji", "yasin patel"];
const INCIDENT_EMAILS = ["imteyaz.omarji@boltondarululoom.org.uk"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,email,full_name").eq("id", user.id).single();
    const allowed = me && (me.role === "admin" || INCIDENT_NAMES.includes((me.full_name || "").trim().toLowerCase()) || INCIDENT_EMAILS.includes((me.email || "").toLowerCase()));
    if (!allowed) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const { data: rows } = await svc.from("incident_log").select("*").order("created_at", { ascending: false }).limit(200);
      const pupilIds = [...new Set((rows ?? []).map((r: any) => r.pupil_id))];
      const byId: Record<string, any> = {};
      if (pupilIds.length) { const { data: ps } = await svc.from("pupils").select("id,first_name,last_name,academic_year").in("id", pupilIds); (ps ?? []).forEach((p: any) => (byId[p.id] = p)); }
      const uids = [...new Set((rows ?? []).map((r: any) => r.logged_by).filter(Boolean))];
      const uById: Record<string, string> = {};
      if (uids.length) { const { data: us } = await svc.from("profiles").select("id,full_name").in("id", uids); (us ?? []).forEach((u: any) => (uById[u.id] = u.full_name)); }
      const incidents = (rows ?? []).map((r: any) => ({ ...r, pupil_name: byId[r.pupil_id] ? `${byId[r.pupil_id].first_name} ${byId[r.pupil_id].last_name}` : "(unknown pupil)", academic_year: byId[r.pupil_id]?.academic_year || "", logged_by_name: uById[r.logged_by] || "—" }));
      return json({ ok: true, incidents });
    }

    if (action === "create") {
      const pupil_id = body.pupil_id;
      const body_area = (body.body_area || "").trim();
      const what_happened = (body.what_happened || "").trim();
      const action_taken = (body.action_taken || "").trim();
      if (!pupil_id || !body_area || !what_happened) return json({ error: "pupil, body area and what happened are all required" }, 400);
      const { data: pupil } = await svc.from("pupils").select("first_name,last_name").eq("id", pupil_id).single();
      if (!pupil) return json({ error: "pupil not found" }, 404);
      const childName = `${pupil.first_name} ${pupil.last_name}`.trim();
      const { data: pp } = await svc.from("parent_pupil").select("parent_id").eq("pupil_id", pupil_id);
      const parentIds = [...new Set((pp ?? []).map((x: any) => x.parent_id))];

      const { data: cfgRows } = await svc.from("app_config").select("key,value");
      const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
      const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
      if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);

      const subject = `A message from Al Jamiatul Islamiyah about ${childName}`;
      const actionLine = action_taken ? `\n\nWhat we did: ${action_taken}` : "";
      const bodyText =
`Assalamu alaikum,

This is a message from Al Jamiatul Islamiyah.

We are writing to let you know that your son ${childName} had an incident today involving his ${body_area}.

What happened: ${what_happened}${actionLine}

${childName} has been seen to and is being looked after here at the madrasa. If you have any questions or would like to speak to us, please reply to this message or contact the school office.

JazakAllahu khairan.`;
      const pushBody = `${childName} had an incident involving his ${body_area}. Tap to read.`;

      let emailed = 0, pushed = 0;
      for (const parentId of parentIds) {
        const { data: prof } = await svc.from("profiles").select("email,full_name").eq("id", parentId).single();
        let conv: any;
        const { data: existing } = await svc.from("conversations").select("*").eq("parent_id", parentId).order("last_message_at", { ascending: false }).limit(1);
        conv = existing?.[0];
        if (!conv) { const { data: made } = await svc.from("conversations").insert({ parent_id: parentId, subject: "Welfare" }).select().single(); conv = made; }
        if (conv) {
          await svc.from("messages").insert({ conversation_id: conv.id, sender_id: user.id, sender_role: "staff", body: bodyText, read_by_staff: true, read_by_parent: false });
          await svc.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conv.id);
        }
        if (brevoReady && prof?.email) {
          try {
            const r = await fetch("https://api.brevo.com/v3/smtp/email", {
              method: "POST",
              headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({
                sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email },
                to: [{ email: prof.email, name: prof.full_name || "Parent" }],
                subject,
                htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#14294D">${subject}</h2><p style="white-space:pre-wrap">${bodyText}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>`,
              }),
            });
            if (r.ok) emailed++;
          } catch { /* ignore */ }
        }
        const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", parentId);
        const payload = JSON.stringify({ title: subject, body: pushBody, url: "/", kind: "message" });
        for (const s of subs ?? []) {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushed++; }
          catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); }
        }
      }

      const { data: row } = await svc.from("incident_log").insert({ pupil_id, body_area, what_happened, action_taken: action_taken || null, logged_by: user.id, notified_parents: parentIds.length, notify_emailed: emailed, notify_pushed: pushed }).select().single();
      return json({ ok: true, incident: row, parents: parentIds.length, emailed, pushed });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
