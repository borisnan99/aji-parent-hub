// safeguarding — confidential concern log. Any staff can report; only the DSL / Deputy DSLs can view and action.
// DSL: Mohammed Atcha. Deputy DSLs: Luqman Amla, Imteyaz Omarji.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const SAFE_NAMES = ["mohammed atcha", "luqman amla", "imteyaz omarji"];
const SAFE_EMAILS = ["mohammed.atcha@boltondarululoom.org.uk", "luqman.amla@boltondarululoom.org.uk", "imteyaz.omarji@boltondarululoom.org.uk"];
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
    const canView = SAFE_NAMES.includes(nm) || SAFE_EMAILS.includes(em);
    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    async function decorate(rows: any[]) {
      const pids = [...new Set(rows.map((r) => r.about_pupil_id).filter(Boolean))];
      const pm: Record<string, any> = {};
      if (pids.length) { const { data } = await svc.from("pupils").select("id,first_name,last_name,academic_year").in("id", pids); (data ?? []).forEach((p: any) => (pm[p.id] = p)); }
      const uids = [...new Set(rows.flatMap((r) => [r.reported_by, r.actioned_by]).filter(Boolean))];
      const um: Record<string, string> = {};
      if (uids.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", uids); (data ?? []).forEach((u: any) => (um[u.id] = u.full_name)); }
      return rows.map((r) => ({ ...r, pupil_name: r.about_pupil_id && pm[r.about_pupil_id] ? `${pm[r.about_pupil_id].first_name} ${pm[r.about_pupil_id].last_name}` : (r.pupil_text || "—"), academic_year: r.about_pupil_id && pm[r.about_pupil_id] ? pm[r.about_pupil_id].academic_year : "", reporter_name: um[r.reported_by] || "—", actioned_by_name: r.actioned_by ? (um[r.actioned_by] || "—") : null }));
    }

    if (action === "report") {
      const details = (body.details || "").trim();
      if (!details) return json({ error: "please describe the concern" }, 400);
      const { data: row, error } = await svc.from("safeguarding_concerns").insert({ about_pupil_id: body.about_pupil_id || null, pupil_text: (body.pupil_text || "").trim() || null, category: (body.category || "").trim() || null, details, reported_by: user.id }).select().single();
      if (error) return json({ error: error.message }, 500);
      try {
        let who = (body.pupil_text || "").trim();
        if (body.about_pupil_id) { const { data: p } = await svc.from("pupils").select("first_name,last_name").eq("id", body.about_pupil_id).single(); if (p) who = `${p.first_name} ${p.last_name}`; }
        const reporter = me.full_name || "a member of staff";
        const { data: cfgRows } = await svc.from("app_config").select("key,value");
        const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
        const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
        if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
        const { data: dsls } = await svc.from("profiles").select("id,email,full_name").in("email", SAFE_EMAILS);
        const subject = "Safeguarding concern logged" + (who ? " — " + who : "");
        const text = `A safeguarding concern has been logged and needs your attention.\n\n${who ? "Regarding: " + who + "\n" : ""}Reported by: ${reporter}\n\nPlease review it in the Parent Hub (Safeguarding). This message contains no details for confidentiality.`;
        for (const d of dsls ?? []) {
          if (brevoReady && d.email) { try { await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email }, to: [{ email: d.email, name: d.full_name || "DSL" }], subject, htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#9A3334">${subject}</h2><p style="white-space:pre-wrap">${text}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Safeguarding</p></div>` }) }); } catch { /* ignore */ } }
          const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", d.id);
          const payload = JSON.stringify({ title: subject, body: "A concern needs your review — tap to open.", url: "/", kind: "safeguarding" });
          for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
        }
      } catch { /* notify best-effort */ }
      return json({ ok: true, id: row.id });
    }

    if (action === "list") {
      const { data: mineRows } = await svc.from("safeguarding_concerns").select("*").eq("reported_by", user.id).order("created_at", { ascending: false }).limit(20);
      const mine = await decorate(mineRows ?? []);
      let concerns: any[] = [];
      if (canView) { const { data } = await svc.from("safeguarding_concerns").select("*").order("created_at", { ascending: false }).limit(200); concerns = await decorate(data ?? []); }
      return json({ ok: true, can_view: canView, concerns, mine });
    }

    if (action === "action") {
      if (!canView) return json({ error: "not permitted" }, 403);
      if (!body.id || !["open", "actioned", "closed"].includes(body.status)) return json({ error: "id and status required" }, 400);
      const { error } = await svc.from("safeguarding_concerns").update({ status: body.status, dsl_notes: (body.dsl_notes || "").trim() || null, actioned_by: user.id, actioned_at: new Date().toISOString() }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
