// staff-notices — in-house staff broadcast.
//  Any staff/admin: inbox, read, read_all (see notices sent to them).
//  Admins only: upload_url (get a signed URL to attach a file), send (to all active staff + admins),
//               sent, sent_detail, email_unread.
//  Notices can carry attachments (PDFs, images, videos, any file) stored in the private
//  'staff-notices' bucket; recipients get time-limited signed links to download them.
//  On send: a web-push notification goes to every recipient; optionally an email too. Later, an
//  admin can email just the recipients who still haven't opened it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const clean = (v: unknown) => { const s = (typeof v === "string" ? v : "").trim(); return s || null; };
const BUCKET = "staff-notices";
const PRI: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "#B23A2E" },
  important: { label: "Important", color: "#C4A24C" },
  update: { label: "Update", color: "#14294D" },
};
const safeName = (s: string) => (s || "file").replace(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 120) || "file";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    if (!me || !["admin", "staff"].includes(me.role)) return json({ error: "staff only" }, 403);
    const isAdmin = me.role === "admin";

    const body = await req.json().catch(() => ({}));
    const action = body.action || "inbox";

    async function nameMap(ids: string[]): Promise<Record<string, string>> {
      const u = [...new Set(ids.filter(Boolean))]; const m: Record<string, string> = {};
      if (u.length) { const { data } = await svc.from("profiles").select("id,full_name").in("id", u); (data ?? []).forEach((r: any) => (m[r.id] = r.full_name)); }
      return m;
    }
    async function cfg() { const c: Record<string, string> = {}; const { data } = await svc.from("app_config").select("key,value"); (data ?? []).forEach((r: any) => (c[r.key] = r.value)); return c; }
    // turn stored attachment records into {name,type,size,path,url} with a fresh signed download link
    async function signAtt(atts: any, ttl = 60 * 60 * 24): Promise<any[]> {
      const list = Array.isArray(atts) ? atts : [];
      const out: any[] = [];
      for (const a of list) {
        if (!a || !a.path) continue;
        let link: string | null = null;
        try { const { data } = await svc.storage.from(BUCKET).createSignedUrl(a.path, ttl); link = data?.signedUrl ?? null; } catch { /* best effort */ }
        out.push({ name: a.name || "file", type: a.type || "", size: a.size || 0, path: a.path, url: link });
      }
      return out;
    }
    // normalise an incoming attachments array from the client into what we store
    const takeAtts = (raw: any) => (Array.isArray(raw) ? raw : []).slice(0, 12)
      .map((a: any) => ({ path: String(a?.path || "").trim(), name: String(a?.name || "file").slice(0, 200), type: String(a?.type || "").slice(0, 150), size: Number(a?.size) || 0 }))
      .filter((a: any) => a.path);

    if (action === "inbox") {
      const { data: recs } = await svc.from("staff_message_recipients").select("message_id,read_at").eq("user_id", user.id);
      const mids = (recs ?? []).map((r: any) => r.message_id);
      const readMap: Record<string, string | null> = {}; (recs ?? []).forEach((r: any) => (readMap[r.message_id] = r.read_at));
      let msgs: any[] = [];
      if (mids.length) { const { data } = await svc.from("staff_messages").select("*").in("id", mids).order("created_at", { ascending: false }); msgs = data ?? []; }
      const nmap = await nameMap(msgs.map((m: any) => m.sender_id));
      const out: any[] = [];
      for (const m of msgs) out.push({ id: m.id, priority: m.priority, subject: m.subject, body: m.body, created_at: m.created_at, sender_name: nmap[m.sender_id] || "The school", read: !!readMap[m.id], read_at: readMap[m.id] || null, attachments: await signAtt(m.attachments) });
      return json({ ok: true, is_admin: isAdmin, unread: out.filter((m) => !m.read).length, messages: out });
    }

    if (action === "read") {
      if (!body.message_id) return json({ error: "message_id required" }, 400);
      await svc.from("staff_message_recipients").update({ read_at: new Date().toISOString() }).eq("message_id", body.message_id).eq("user_id", user.id).is("read_at", null);
      return json({ ok: true });
    }

    if (action === "read_all") {
      await svc.from("staff_message_recipients").update({ read_at: new Date().toISOString() }).eq("user_id", user.id).is("read_at", null);
      return json({ ok: true });
    }

    // ---- admin only below ----
    if (!isAdmin) return json({ error: "admins only" }, 403);

    if (action === "upload_url") {
      // hand the browser a one-time signed URL to upload one file directly to private storage
      const name = safeName(String(body.filename || "file"));
      const path = `notices/${crypto.randomUUID()}/${name}`;
      const { data, error } = await svc.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, bucket: BUCKET, path, token: data.token, signed_url: data.signedUrl });
    }

    if (action === "send") {
      const priority = ["urgent", "important", "update"].includes(body.priority) ? body.priority : "update";
      const subject = clean(body.subject);
      const bodyText = clean(body.body);
      const atts = takeAtts(body.attachments);
      if (!bodyText && !atts.length) return json({ error: "write a message or add an attachment" }, 400);
      const emailNow = body.email_now === true;

      const { data: staff } = await svc.from("profiles").select("id,full_name,email").in("role", ["admin", "staff"]).eq("is_active", true);
      const recipients = (staff ?? []).filter((p: any) => p.id !== user.id);
      if (!recipients.length) return json({ error: "no staff to send to" }, 400);

      const { data: msg, error } = await svc.from("staff_messages").insert({ sender_id: user.id, priority, subject, body: bodyText || "", attachments: atts }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      const rows = recipients.map((p: any) => ({ message_id: msg.id, user_id: p.id }));
      const { error: e2 } = await svc.from("staff_message_recipients").insert(rows);
      if (e2) return json({ error: e2.message }, 500);

      const c = await cfg();
      const pri = PRI[priority];
      const senderName = me.full_name || "The school";
      const attNote = atts.length ? ` 📎 ${atts.length} attachment${atts.length > 1 ? "s" : ""}` : "";
      // push to every recipient
      try {
        if (c.vapid_public) webpush.setVapidDetails(c.vapid_subject, c.vapid_public, c.vapid_private);
        const { data: subs } = await svc.from("push_subscriptions").select("user_id,endpoint,p256dh,auth").in("user_id", recipients.map((p: any) => p.id));
        const payload = JSON.stringify({ title: `${pri.label} · ${senderName}`, body: (subject || bodyText || "New staff notice").slice(0, 120) + attNote, url: "/", kind: "staff-notice" });
        for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
      } catch { /* push best-effort */ }

      let emailed = 0;
      if (emailNow) emailed = await emailRecipients(svc, c, recipients, senderName, priority, subject, bodyText || "", msg.id);
      return json({ ok: true, message_id: msg.id, recipients: recipients.length, attachments: atts.length, emailed });
    }

    if (action === "sent") {
      const { data: msgs } = await svc.from("staff_messages").select("*").order("created_at", { ascending: false }).limit(100);
      const ids = (msgs ?? []).map((m: any) => m.id);
      const counts: Record<string, { total: number; read: number; emailed: number }> = {};
      if (ids.length) { const { data: recs } = await svc.from("staff_message_recipients").select("message_id,read_at,emailed_at").in("message_id", ids); (recs ?? []).forEach((r: any) => { const c = (counts[r.message_id] = counts[r.message_id] || { total: 0, read: 0, emailed: 0 }); c.total++; if (r.read_at) c.read++; if (r.emailed_at) c.emailed++; }); }
      const nmap = await nameMap((msgs ?? []).map((m: any) => m.sender_id));
      const out: any[] = [];
      for (const m of msgs ?? []) out.push({ id: m.id, priority: m.priority, subject: m.subject, body: m.body, created_at: m.created_at, sender_name: nmap[m.sender_id] || "", attachments: await signAtt(m.attachments), ...(counts[m.id] || { total: 0, read: 0, emailed: 0 }) });
      return json({ ok: true, messages: out });
    }

    if (action === "sent_detail") {
      if (!body.message_id) return json({ error: "message_id required" }, 400);
      const { data: recs } = await svc.from("staff_message_recipients").select("user_id,read_at,emailed_at").eq("message_id", body.message_id);
      const nmap = await nameMap((recs ?? []).map((r: any) => r.user_id));
      const people = (recs ?? []).map((r: any) => ({ name: nmap[r.user_id] || "—", read: !!r.read_at, emailed: !!r.emailed_at }))
        .sort((a, b) => (a.read === b.read ? a.name.localeCompare(b.name) : (a.read ? 1 : -1)));
      return json({ ok: true, people });
    }

    if (action === "email_unread") {
      if (!body.message_id) return json({ error: "message_id required" }, 400);
      const { data: msg } = await svc.from("staff_messages").select("*").eq("id", body.message_id).single();
      if (!msg) return json({ error: "message not found" }, 404);
      const { data: recs } = await svc.from("staff_message_recipients").select("user_id").eq("message_id", body.message_id).is("read_at", null);
      const unreadIds = (recs ?? []).map((r: any) => r.user_id);
      if (!unreadIds.length) return json({ ok: true, emailed: 0 });
      const { data: profs } = await svc.from("profiles").select("id,full_name,email").in("id", unreadIds);
      const c = await cfg();
      const nmap = await nameMap([msg.sender_id]);
      const emailed = await emailRecipients(svc, c, profs ?? [], nmap[msg.sender_id] || "The school", msg.priority, msg.subject, msg.body, msg.id);
      return json({ ok: true, emailed });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});

async function emailRecipients(svc: any, c: Record<string, string>, people: any[], senderName: string, priority: string, subject: string | null, bodyText: string, messageId: string): Promise<number> {
  const ready = !!(c.brevo_api_key && c.brevo_sender_email && c.brevo_sender_email !== "PENDING");
  if (!ready) return 0;
  const pri = PRI[priority] || PRI.update;
  const subj = `[${pri.label}] ${subject || "Staff notice"} — Al Jamiatul Islamiyah`;
  // build attachment download links (valid 7 days — these sit in an inbox)
  let attHtml = "";
  try {
    const { data: msg } = await svc.from("staff_messages").select("attachments").eq("id", messageId).single();
    const list = Array.isArray(msg?.attachments) ? msg.attachments : [];
    const links: string[] = [];
    for (const a of list) {
      if (!a?.path) continue;
      const { data } = await svc.storage.from(BUCKET).createSignedUrl(a.path, 60 * 60 * 24 * 7);
      if (data?.signedUrl) links.push(`<a href="${data.signedUrl}" style="color:#14294D;font-weight:600">${(a.name || "file")}</a>`);
    }
    if (links.length) attHtml = `<div style="margin-top:12px;padding:10px 12px;background:#F7F5EF;border-radius:8px"><div style="font-size:12px;color:#6E6A60;font-weight:700;margin-bottom:4px">📎 ATTACHMENTS</div>${links.map((l) => `<div style="margin:3px 0">${l}</div>`).join("")}<div style="font-size:11px;color:#9A948A;margin-top:6px">Links are valid for 7 days — sign in to the Parent Hub any time to view them again.</div></div>`;
  } catch { /* attachments best-effort */ }
  let emailed = 0;
  for (const p of people) {
    if (!p.email) continue;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto;color:#1B2438">
      <div style="background:${pri.color};color:#fff;padding:8px 14px;border-radius:10px 10px 0 0;font-weight:700;font-size:13px;letter-spacing:1px">${pri.label.toUpperCase()} · STAFF NOTICE</div>
      <div style="border:1px solid #E8E3D6;border-top:none;border-radius:0 0 10px 10px;padding:16px">
        ${subject ? `<h2 style="color:#14294D;margin:0 0 8px">${subject}</h2>` : ""}
        ${bodyText ? `<p style="white-space:pre-wrap;font-size:15px;line-height:1.6">${bodyText}</p>` : ""}
        ${attHtml}
        <hr style="border:none;border-top:1px solid #E8E3D6;margin-top:14px"/>
        <p style="color:#6E6A60;font-size:12px">Sent by ${senderName} · Al Jamiatul Islamiyah — Bolton Darul Uloom. Please sign in to the Parent Hub to confirm you have seen staff notices.</p>
      </div></div>`;
    try {
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": c.brevo_api_key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: c.brevo_sender_name || "Al Jamiatul Islamiyah", email: c.brevo_sender_email }, to: [{ email: p.email, name: p.full_name || "Staff" }], subject: subj, htmlContent: html }) });
      if (resp.ok) { emailed++; await svc.from("staff_message_recipients").update({ emailed_at: new Date().toISOString() }).eq("message_id", messageId).eq("user_id", p.id); }
    } catch { /* continue */ }
  }
  return emailed;
}
