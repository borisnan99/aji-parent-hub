// send-praise-awards — once a month's praise results are published, message each award-winner's
// parent(s) a positive note (tiered Gold/Silver/Bronze) and deliver their son's certificate.
//   preview : who would be messaged (matched parents, already-sent), no sending.
//   send    : one pupil — upload his certificate PDF, post an in-app message + push to each
//             parent, and email it with the certificate attached. Recorded so it won't double-send.
// Access: admins and attendance/office leads (staff_access.is_full).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const AWARDS = ["Gold", "Silver", "Bronze"];
const first = (full: string) => String(full || "").trim().split(/\s+/)[0] || "your son";

function plainBody(award: string, name: string, pct: number, month: string) {
  const f = first(name);
  if (award === "Gold") return `Assalāmu ʿalaykum wa raḥmatullāh,\n\nMāshāʾAllāh! We are delighted to tell you that ${f} has earned a GOLD award in this month's Praise Points for ${month}, with an outstanding ${pct}%.\n\nThis is a wonderful achievement and a reflection of his excellent effort, good character and consistency all month. We are extremely proud of him — please do congratulate him from all of us. May Allah ﷻ bless him, increase him in knowledge and keep him excelling.\n\nHis certificate is attached to this message.`;
  if (award === "Silver") return `Assalāmu ʿalaykum wa raḥmatullāh,\n\nMāshāʾAllāh! We are very pleased to tell you that ${f} has earned a SILVER award in this month's Praise Points for ${month}, achieving ${pct}%.\n\nThis is a strong result and something to be proud of — he has worked hard and shown good character this month. With a little more consistency he can reach gold next month, in shāʾ Allāh. Please do congratulate him from all of us.\n\nHis certificate is attached to this message.`;
  return `Assalāmu ʿalaykum wa raḥmatullāh,\n\nMāshāʾAllāh! We are glad to tell you that ${f} has earned a BRONZE award in this month's Praise Points for ${month}, achieving ${pct}%.\n\nThis is a good effort and a positive result — well done to him. We encourage him to keep building on this, and we look forward to seeing him go from strength to strength, in shāʾ Allāh. Please do congratulate him from all of us.\n\nHis certificate is attached to this message.`;
}
function emailHtml(award: string, name: string, pct: number, month: string) {
  const tier: Record<string, string[]> = { Gold: ["#B8912F", "🥇 GOLD AWARD"], Silver: ["#7A808A", "🥈 SILVER AWARD"], Bronze: ["#9C6B38", "🥉 BRONZE AWARD"] };
  const [col, label] = tier[award] || tier.Bronze;
  const body = plainBody(award, name, pct, month).split("\n").filter((l) => l.trim()).map((l) => `<p style="margin:0 0 10px">${l}</p>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1B2438;max-width:600px;margin:0 auto;font-size:15px;line-height:1.6">
<div style="background:#14294D;color:#fff;padding:16px 18px;border-radius:12px 12px 0 0"><span style="font-family:Georgia,serif;font-size:19px;font-weight:bold">Praise Points — ${month}</span><br><span style="color:#C9D3E6;font-size:13px">Al Jamiatul Islamiyah · Bolton Darul Uloom</span></div>
<div style="border:1px solid #E4DECF;border-top:none;border-radius:0 0 12px 12px;padding:18px">
<div style="background:${col};color:#fff;border-radius:8px;padding:10px 13px;margin:0 0 14px;font-weight:bold;text-align:center;font-size:16px">${label} · ${pct}%</div>
${body}
<p style="margin:16px 0 0">JazākumAllāhu khayran,<br><b style="color:#14294D">Maulana Luqmān Amla</b><br>Principal — Al Jamiatul Islamiyah</p></div></div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    const { data: acc } = await svc.from("staff_access").select("is_full").eq("user_id", user.id).maybeSingle();
    if (!me || (me.role !== "admin" && !(acc && acc.is_full))) return json({ error: "not permitted" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "preview";
    const period = (body.period || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const [yy, mm] = period.split("-");
    const month = new Date(+yy, +mm - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    // parents for a pupil
    const parentsFor = async (pupilId: string) => {
      const { data: links } = await svc.from("parent_pupil").select("parent_id").eq("pupil_id", pupilId);
      const ids = (links ?? []).map((l: any) => l.parent_id);
      if (!ids.length) return [] as any[];
      const { data: profs } = await svc.from("profiles").select("id,email,full_name").in("id", ids);
      return profs ?? [];
    };

    if (action === "preview") {
      const { data: results } = await svc.from("praise_results").select("pupil_id,student_name,award,pct").eq("period", period).in("award", AWARDS);
      const { data: sent } = await svc.from("praise_award_sends").select("pupil_id").eq("period", period);
      const sentSet = new Set((sent ?? []).map((r: any) => r.pupil_id));
      const out: any[] = [];
      for (const r of results ?? []) {
        if (!r.pupil_id) continue;
        const ps = await parentsFor(r.pupil_id);
        out.push({ pupil_id: r.pupil_id, name: r.student_name, award: r.award, pct: r.pct, parents: ps.map((p: any) => ({ name: p.full_name, email: p.email })), parent_count: ps.length, already_sent: sentSet.has(r.pupil_id) });
      }
      out.sort((a, b) => AWARDS.indexOf(a.award) - AWARDS.indexOf(b.award) || String(a.name).localeCompare(String(b.name)));
      const summary = { winners: out.length, with_parents: out.filter((x) => x.parent_count > 0).length, no_parent: out.filter((x) => x.parent_count === 0).length, already_sent: out.filter((x) => x.already_sent).length };
      return json({ ok: true, period, month, summary, winners: out });
    }

    if (action === "send") {
      if (!body.pupil_id || !body.pdf_base64) return json({ error: "pupil_id and pdf_base64 required" }, 400);
      if (!body.force) { const { data: already } = await svc.from("praise_award_sends").select("pupil_id").eq("period", period).eq("pupil_id", body.pupil_id).maybeSingle(); if (already) return json({ ok: true, skipped: true }); }
      const { data: r } = await svc.from("praise_results").select("pupil_id,student_name,award,pct").eq("period", period).eq("pupil_id", body.pupil_id).maybeSingle();
      if (!r || !AWARDS.includes(r.award)) return json({ error: "no award for this pupil" }, 400);
      const parents = await parentsFor(body.pupil_id);

      // decode + store the certificate
      const bin = atob(String(body.pdf_base64));
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const path = `praise/${period}/${body.pupil_id}.pdf`;
      await svc.storage.from("attachments").upload(path, bytes, { contentType: "application/pdf", upsert: true });
      const fileName = `${r.student_name} — ${r.award} Certificate (${month}).pdf`;

      const text = plainBody(r.award, r.student_name, r.pct, month);
      const html = emailHtml(r.award, r.student_name, r.pct, month);

      // push config + brevo
      const { data: cfgRows } = await svc.from("app_config").select("key,value");
      const cfg: Record<string, string> = {}; (cfgRows ?? []).forEach((x: any) => (cfg[x.key] = x.value));
      let pushReady = false; try { webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private); pushReady = true; } catch (_) { pushReady = false; }
      const brevo = cfg.brevo_api_key, sender = cfg.brevo_sender_email || "luqman.amla@boltondarululoom.org.uk";

      let inApp = 0, emails = 0, push = 0;
      for (const p of parents) {
        // in-app message in the parent's open conversation (create if needed)
        const { data: existing } = await svc.from("conversations").select("*").eq("parent_id", p.id).eq("status", "open").order("last_message_at", { ascending: false }).limit(1);
        let conv = existing?.[0];
        if (!conv) { const { data: made } = await svc.from("conversations").insert({ parent_id: p.id, subject: "Praise Points — " + month }).select().single(); conv = made; }
        if (conv) {
          await svc.from("messages").insert({ conversation_id: conv.id, sender_id: user.id, sender_role: "staff", body: text + "\n\n— Maulana Luqman Amla, Principal", attachment_path: path, attachment_name: fileName, attachment_type: "application/pdf", read_by_staff: true, read_by_parent: false });
          await svc.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conv.id);
          inApp++;
          if (pushReady) {
            const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", p.id);
            const payload = JSON.stringify({ title: r.award + " award for " + first(r.student_name) + "! 🎉", body: "A message and certificate from the school.", url: "/", kind: "message" });
            for (const s of subs ?? []) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); push++; } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); } }
          }
        }
        // email with the certificate attached
        if (brevo && p.email) {
          try {
            const resp = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": brevo, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: "Maulana Luqmān Amla", email: sender }, to: [{ email: p.email, name: p.full_name || "Parent" }], replyTo: { email: sender }, subject: `${r.award} Award for ${first(r.student_name)} — Praise Points (${month})`, htmlContent: html, attachment: [{ content: String(body.pdf_base64), name: fileName }] }) });
            if (resp.ok) emails++;
          } catch (_) { /* continue */ }
        }
      }
      await svc.from("praise_award_sends").upsert({ period, pupil_id: body.pupil_id, award: r.award, parents: parents.length, emails, push, sent_by: user.id, sent_at: new Date().toISOString() }, { onConflict: "period,pupil_id" });
      return json({ ok: true, pupil_id: body.pupil_id, parents: parents.length, in_app: inApp, emails, push });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
