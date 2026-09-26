// send-announcement — publish + fan out (push free; email fallback + urgent). Supports attachments and mode:'test'.
// Email to parents WITHOUT the app: shows images inline + includes a "download/bookmark" nudge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY"), { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const p = await req.json();
    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    const cfg = {}; (cfgRows ?? []).forEach((r) => (cfg[r.key] = r.value));
    webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
    if (p.mode === "test") {
      const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", user.id);
      let pushed = 0;
      for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: "Test notification", body: "Push is working \u2713", kind: "test" })); pushed++; } catch (e) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
      return json({ ok: true, pushed, recipients: 1 });
    }
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    if (!me || !["admin", "staff"].includes(me.role)) return json({ error: "staff only" }, 403);
    const title = p.title; const bodyText = (p.body ?? p.message ?? ""); const priority = p.priority ?? "normal"; const group_ids = p.group_ids ?? []; const attachments = Array.isArray(p.attachments) ? p.attachments : [];
    if (!title || !Array.isArray(group_ids) || group_ids.length === 0) return json({ error: "title and at least one group required" }, 400);
    const brevoReady = !!(cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING");
    const { data: ann, error: annErr } = await svc.from("announcements").insert({ title, body: bodyText, priority, status: "published", publish_at: new Date().toISOString(), created_by: user.id }).select().single();
    if (annErr) return json({ error: annErr.message }, 500);
    await svc.from("announcement_targets").insert(group_ids.map((g) => ({ announcement_id: ann.id, group_id: g })));
    // store attachments + build email HTML (images inline, other files as links; 7-day signed URLs)
    let attachHtml = "";
    if (attachments.length) {
      await svc.from("announcement_attachments").insert(attachments.map((a) => ({ announcement_id: ann.id, storage_path: a.path, file_name: a.name, mime_type: a.type, size_bytes: a.size || null })));
      const imgs = []; const files = [];
      for (const a of attachments) {
        const { data: su } = await svc.storage.from("attachments").createSignedUrl(a.path, 604800);
        if (!su?.signedUrl) continue;
        if ((a.type || "").startsWith("image/")) imgs.push(`<img src="${su.signedUrl}" alt="${a.name}" style="max-width:100%;border-radius:8px;margin-top:12px"/>`);
        else files.push(`<a href="${su.signedUrl}">\uD83D\uDCCE ${a.name}</a>`);
      }
      attachHtml = (imgs.length ? imgs.join("") : "") + (files.length ? `<p style="margin-top:14px"><b>Attachments:</b><br/>${files.join("<br/>")}</p>` : "");
    }
    const nudgeHtml = `<div style="margin-top:16px;padding:12px 14px;background:#FAF8F3;border:1px solid #E8E3D6;border-radius:8px;font-size:13px;color:#14294D"><b>\uD83D\uDCF2 Make it easier for yourself</b><br/>Get these updates instantly on your phone. Open <a href="https://aji-parent-hub.vercel.app" style="color:#14294D;font-weight:bold">aji-parent-hub.vercel.app</a>, sign in with the details we emailed you, then add it to your home screen (or bookmark it). If you need any help, just reply to this email.</div>`;
    const parentIds = new Set();
    for (const g of group_ids) { const { data } = await svc.rpc("resolve_group_parents", { g_id: g }); (data ?? []).forEach((r) => parentIds.add(r.parent_id)); }
    let pushed = 0, emailed = 0; const isUrgent = priority === "urgent";
    for (const pid of parentIds) {
      const [{ data: subs }, { data: prof }, { data: pref }] = await Promise.all([
        svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", pid),
        svc.from("profiles").select("email,full_name").eq("id", pid).single(),
        svc.from("parent_preferences").select("email_opt_in").eq("parent_id", pid).maybeSingle() ]);
      const hasPush = (subs ?? []).length > 0;
      for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body: bodyText, priority, id: ann.id })); pushed++; } catch (e) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
      const wantEmail = (!hasPush || isUrgent) && pref?.email_opt_in !== false; let emailStatus = "skipped_has_push";
      if (wantEmail && brevoReady && prof?.email) {
        try { const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email }, to: [{ email: prof.email, name: prof.full_name }], subject: (isUrgent ? "[URGENT] " : "") + title, htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto"><h2 style="color:#14294D">${title}</h2><p style="white-space:pre-wrap">${bodyText}</p>${attachHtml}${!hasPush ? nudgeHtml : ""}<hr style="border:none;border-top:1px solid #E8E3D6;margin-top:16px"/><p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>` }) }); emailStatus = r.ok ? "sent" : "failed"; if (r.ok) emailed++; } catch { emailStatus = "failed"; }
      } else if (wantEmail && !brevoReady) { emailStatus = "skipped_no_sender"; }
      await svc.from("announcement_recipients").upsert({ announcement_id: ann.id, parent_id: pid, email_status: emailStatus, delivered_at: hasPush ? new Date().toISOString() : null });
    }
    return json({ ok: true, announcement_id: ann.id, recipients: parentIds.size, pushed, emailed, email_ready: brevoReady, attachments: attachments.length });
  } catch (e) { return json({ error: String(e?.message ?? e) }, 500); }
});
