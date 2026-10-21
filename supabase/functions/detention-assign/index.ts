// detention-assign — Yasin Patel (behaviour manager) + admins assign a break-time (15 min) or
// dinner-time detention directly, and notify the parents. The notification is always sent; the
// assigner chooses whether to just notify, or to add a short note explaining why — which goes
// straight to the parents in the same message (in-app + email + push).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const YASIN_EMAIL = "yasin.patel@boltondarululoom.org.uk";
const REVIEW_NAMES = ["yasin patel"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,email,full_name").eq("id", user.id).single();
    if (!me || !["admin", "staff"].includes(me.role)) return json({ error: "staff only" }, 403);
    const em = (me.email || "").toLowerCase(), nm = (me.full_name || "").trim().toLowerCase();
    const canAssign = me.role === "admin" || em === YASIN_EMAIL || REVIEW_NAMES.includes(nm);
    if (!canAssign) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const pupilId = body.pupil_id;
    if (!pupilId) return json({ error: "pupil required" }, 400);
    const kind = body.kind === "dinner" ? "dinner" : "break";
    const dateStr = (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : new Date().toISOString().slice(0, 10);
    const note = (typeof body.note === "string" ? body.note.trim() : "").slice(0, 1000);

    const { data: pupil } = await svc.from("pupils").select("first_name,last_name").eq("id", pupilId).single();
    if (!pupil) return json({ error: "pupil not found" }, 404);
    const childName = `${pupil.first_name} ${pupil.last_name}`;
    const label = kind === "dinner" ? "Dinner-time detention" : "Break-time detention (15 minutes)";
    const reason = note ? `${label} — ${note}` : label;

    // week_start = Monday of the detention's week (column is NOT NULL)
    const d0 = new Date(dateStr + "T00:00:00Z");
    const dow0 = (d0.getUTCDay() + 6) % 7; // 0 = Monday
    const mon = new Date(d0); mon.setUTCDate(d0.getUTCDate() - dow0);
    const wkStr = mon.toISOString().slice(0, 10);

    const { data: det, error: de } = await svc.from("detentions").insert({ pupil_id: pupilId, week_start: wkStr, detention_date: dateStr, detention_type: kind, reason, created_by: user.id }).select().single();
    if (de) return json({ error: de.message }, 500);

    // notify parents (always) — in-app message + email + push
    let delivered = 0;
    try {
      const when = new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const kindText = kind === "dinner" ? "a dinner-time detention" : "a 15-minute break-time detention";
      const { data: pp } = await svc.from("parent_pupil").select("parent_id").eq("pupil_id", pupilId);
      const parentIds = [...new Set((pp ?? []).map((x: any) => x.parent_id))];
      const { data: cfgRows } = await svc.from("app_config").select("key,value");
      const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
      const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
      if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
      const subject = `Detention — ${childName}`;
      const noteLine = note ? `\n\nNote from school: ${note}` : "";
      const bodyText = `Assalamu alaikum,\n\nThis is a message from Al Jamiatul Islamiyah.\n\nYour son ${childName} has been given ${kindText} on ${when}.${noteLine}\n\nWe will support him to reflect and improve, insha'Allah. If you would like to discuss this, please reply to this message or contact the school office.\n\nJazakAllahu khairan.`;
      for (const parentId of parentIds) {
        const { data: prof } = await svc.from("profiles").select("email,full_name").eq("id", parentId).single();
        let conv: any;
        const { data: existing } = await svc.from("conversations").select("*").eq("parent_id", parentId).order("last_message_at", { ascending: false }).limit(1);
        conv = existing?.[0];
        if (!conv) { const { data: made } = await svc.from("conversations").insert({ parent_id: parentId, subject: "Behaviour" }).select().single(); conv = made; }
        if (conv) { await svc.from("messages").insert({ conversation_id: conv.id, sender_id: user.id, sender_role: "staff", body: bodyText, read_by_staff: true, read_by_parent: false }); await svc.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conv.id); }
        if (brevoReady && prof?.email) { try { await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email }, to: [{ email: prof.email, name: prof.full_name || "Parent" }], subject, htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#14294D">${subject}</h2><p style="white-space:pre-wrap">${bodyText}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>` }) }); delivered++; } catch { /* ignore */ } }
        const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", parentId);
        const payload = JSON.stringify({ title: subject, body: `${childName} has ${kindText} on ${when}.`, url: "/", kind: "message" });
        for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
      }
      await svc.from("detentions").update({ notified_at: new Date().toISOString() }).eq("id", det.id);
    } catch { /* notify best-effort */ }

    return json({ ok: true, id: det.id, kind, delivered });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
