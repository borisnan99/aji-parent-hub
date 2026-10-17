// behaviour — C-code behaviour sanctions. Teachers log a C-code; Yasin Patel (behaviour manager) reviews,
// records the pupil's statement (+ optional photo of the handwritten statement), confirms, and can set a Saturday detention.
// Access: any staff/admin can log; review + detention: admins + Yasin Patel.
// Actions: load, log, review, detention.
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
    const isAdmin = me.role === "admin";
    const em = (me.email || "").toLowerCase(), nm = (me.full_name || "").trim().toLowerCase();
    const canReview = isAdmin || em === YASIN_EMAIL || REVIEW_NAMES.includes(nm);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "load";

    async function names(ids: string[]): Promise<Record<string, string>> {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, string> = {};
      if (u.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", u); (data ?? []).forEach((r: any) => (m[r.id] = r.full_name)); }
      return m;
    }
    async function pupnames(ids: string[]): Promise<Record<string, any>> {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, any> = {};
      if (u.length) { const { data } = await svc.from("pupils").select("id,first_name,last_name,academic_year").in("id", u); (data ?? []).forEach((r: any) => (m[r.id] = r)); }
      return m;
    }
    async function signed(path: string | null): Promise<string | null> {
      if (!path) return null;
      const { data } = await svc.storage.from("attachments").createSignedUrl(path, 3600);
      return data?.signedUrl || null;
    }
    async function decorate(rows: any[]) {
      const pm = await pupnames(rows.map((r) => r.pupil_id));
      const nmap = await names(rows.flatMap((r) => [r.logged_by, r.reviewed_by]));
      const detIds = rows.map((r) => r.detention_id).filter(Boolean);
      const dmap: Record<string, any> = {};
      if (detIds.length) { const { data: ds } = await svc.from("detentions").select("id,detention_date,status").in("id", detIds); (ds ?? []).forEach((d: any) => (dmap[d.id] = d)); }
      const out = [];
      for (const r of rows) {
        const p = pm[r.pupil_id];
        out.push({ ...r, pupil_name: p ? `${p.first_name} ${p.last_name}` : "(unknown)", academic_year: p?.academic_year || "", logged_by_name: nmap[r.logged_by] || "—", reviewed_by_name: r.reviewed_by ? (nmap[r.reviewed_by] || "—") : null, detention: r.detention_id ? dmap[r.detention_id] || null : null, photo_url: await signed(r.statement_photo_path) });
      }
      return out;
    }

    if (action === "load") {
      const { data: codes } = await svc.from("behaviour_codes").select("*").order("sort");
      const { data: mineRows } = await svc.from("behaviour_incidents").select("*").eq("logged_by", user.id).order("created_at", { ascending: false }).limit(30);
      const mine = await decorate(mineRows ?? []);
      let queue: any[] = [], history: any[] = [];
      if (canReview) {
        const { data: q } = await svc.from("behaviour_incidents").select("*").eq("status", "pending").order("created_at", { ascending: true });
        queue = await decorate(q ?? []);
        const { data: h } = await svc.from("behaviour_incidents").select("*").in("status", ["confirmed", "dismissed"]).order("reviewed_at", { ascending: false }).limit(40);
        history = await decorate(h ?? []);
      }
      return json({ ok: true, codes: codes ?? [], mine, queue, history, can_review: canReview });
    }

    if (action === "log") {
      const pupil_id = body.pupil_id, code = body.code, period = (body.period || "").trim(), reason = (body.reason || "").trim(), details = (body.details || "").trim();
      if (!pupil_id || !code || !period || !reason) return json({ error: "pupil, period, code and reason are required" }, 400);
      const { data: cd } = await svc.from("behaviour_codes").select("code").eq("code", code).maybeSingle();
      if (!cd) return json({ error: "unknown code" }, 400);
      const { data: row, error } = await svc.from("behaviour_incidents").insert({ pupil_id, code, period, reason, details: details || null, logged_by: user.id }).select().single();
      if (error) return json({ error: error.message }, 500);
      // notify Yasin
      try {
        const { data: pupil } = await svc.from("pupils").select("first_name,last_name").eq("id", pupil_id).single();
        const childName = pupil ? `${pupil.first_name} ${pupil.last_name}` : "a pupil";
        const teacher = me.full_name || "a teacher";
        const { data: cfgRows } = await svc.from("app_config").select("key,value");
        const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
        const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
        if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
        const { data: g } = await svc.from("profiles").select("id,email,full_name").ilike("email", YASIN_EMAIL).maybeSingle();
        const subject = `New ${code} to review — ${childName}`;
        const text = `A ${code} behaviour code has been logged and needs your review.\n\nPupil: ${childName}\nCode: ${code}\nPeriod: ${period}\nReason: ${reason}\nLogged by: ${teacher}${details ? `\n\nDetails: ${details}` : ""}\n\nPlease review it in the Parent Hub, take the pupil's statement, and confirm.`;
        if (brevoReady) {
          try { await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email }, to: [{ email: g?.email || YASIN_EMAIL, name: g?.full_name || "Yasin Patel" }], subject, htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#14294D">${subject}</h2><p style="white-space:pre-wrap">${text}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Behaviour</p></div>` }) }); } catch { /* ignore */ }
        }
        if (g?.id) {
          const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", g.id);
          const payload = JSON.stringify({ title: subject, body: `${code} for ${childName} (period ${period}) — tap to review.`, url: "/", kind: "behaviour" });
          for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
        }
      } catch { /* notify best-effort */ }
      return json({ ok: true, id: row.id });
    }

    if (action === "review") {
      if (!canReview) return json({ error: "not permitted" }, 403);
      const id = body.id; const status = body.status;
      if (!id || !["confirmed", "dismissed"].includes(status)) return json({ error: "id and status required" }, 400);
      const upd: any = { status, pupil_statement: (body.pupil_statement || "").trim() || null, reviewed_by: user.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (typeof body.statement_photo_path === "string" && body.statement_photo_path) upd.statement_photo_path = body.statement_photo_path;
      const { error } = await svc.from("behaviour_incidents").update(upd).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "detention") {
      if (!canReview) return json({ error: "not permitted" }, 403);
      const id = body.id; if (!id) return json({ error: "id required" }, 400);
      const { data: inc } = await svc.from("behaviour_incidents").select("*").eq("id", id).single();
      if (!inc) return json({ error: "not found" }, 404);
      if (inc.status !== "confirmed") return json({ error: "confirm the incident first" }, 400);
      if (inc.detention_id) return json({ error: "a detention is already set for this" }, 400);
      const now = new Date();
      let add = (6 - now.getUTCDay() + 7) % 7; if (add === 0) add = 7; // upcoming Saturday
      const sat = new Date(now); sat.setUTCDate(now.getUTCDate() + add);
      const monday = new Date(sat); monday.setUTCDate(sat.getUTCDate() - 5);
      const satStr = sat.toISOString().slice(0, 10), wkStr = monday.toISOString().slice(0, 10);
      const { data: det, error: de } = await svc.from("detentions").insert({ pupil_id: inc.pupil_id, week_start: wkStr, detention_date: satStr, reason: `${inc.code} — ${inc.reason}`, created_by: user.id }).select().single();
      if (de) return json({ error: de.message }, 500);
      await svc.from("behaviour_incidents").update({ detention_id: det.id, updated_at: new Date().toISOString() }).eq("id", id);
      // notify parents
      try {
        const { data: pupil } = await svc.from("pupils").select("first_name,last_name").eq("id", inc.pupil_id).single();
        const childName = pupil ? `${pupil.first_name} ${pupil.last_name}` : "your son";
        const when = new Date(satStr + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        const { data: pp } = await svc.from("parent_pupil").select("parent_id").eq("pupil_id", inc.pupil_id);
        const parentIds = [...new Set((pp ?? []).map((x: any) => x.parent_id))];
        const { data: cfgRows } = await svc.from("app_config").select("key,value");
        const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
        const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
        if (cfg.vapid_public) webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
        const subject = `Saturday detention — ${childName}`;
        const bodyText = `Assalamu alaikum,\n\nThis is a message from Al Jamiatul Islamiyah.\n\nFollowing a behaviour matter at school, your son ${childName} has been assigned a detention this Saturday (${when}).\n\nWe will support him to reflect and improve, insha'Allah. If you would like to discuss this, please reply to this message or contact the school office.\n\nJazakAllahu khairan.`;
        for (const parentId of parentIds) {
          const { data: prof } = await svc.from("profiles").select("email,full_name").eq("id", parentId).single();
          let conv: any;
          const { data: existing } = await svc.from("conversations").select("*").eq("parent_id", parentId).order("last_message_at", { ascending: false }).limit(1);
          conv = existing?.[0];
          if (!conv) { const { data: made } = await svc.from("conversations").insert({ parent_id: parentId, subject: "Behaviour" }).select().single(); conv = made; }
          if (conv) { await svc.from("messages").insert({ conversation_id: conv.id, sender_id: user.id, sender_role: "staff", body: bodyText, read_by_staff: true, read_by_parent: false }); await svc.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conv.id); }
          if (brevoReady && prof?.email) { try { await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email }, to: [{ email: prof.email, name: prof.full_name || "Parent" }], subject, htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#14294D">${subject}</h2><p style="white-space:pre-wrap">${bodyText}</p><hr style="border:none;border-top:1px solid #E8E3D6"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>` }) }); } catch { /* ignore */ } }
          const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", parentId);
          const payload = JSON.stringify({ title: subject, body: `${childName} has a Saturday detention (${when}).`, url: "/", kind: "message" });
          for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
        }
        await svc.from("detentions").update({ notified_at: new Date().toISOString() }).eq("id", det.id);
      } catch { /* notify best-effort */ }
      return json({ ok: true, detention_date: satStr });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
