// send-exam-marks — receives {week_label, rows:[{name,mark}]} from the Google Sheet (Apps Script),
// matches each boy to his parent(s), and emails the mark with tiered praise. dry_run returns a preview.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const norm = (s: string) => (s || "").toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

function praise(m: number) {
  if (m === 10) return `<div style="background:#EFE4C4;border-radius:8px;padding:11px 13px;margin:12px 0;color:#14294D">🌟 <b>MāshāʾAllāh — a perfect 10 out of 10!</b> An outstanding result. May Allah bless him, increase him in knowledge, and keep him excelling.</div>`;
  if (m >= 9) return `<div style="background:#EAF0E7;border-radius:8px;padding:11px 13px;margin:12px 0;color:#3F6B4E"><b>MāshāʾAllāh — an excellent result!</b> A wonderful effort — he should be very proud. Keep it up!</div>`;
  if (m > 8) return `<div style="background:#F3F1E8;border-radius:8px;padding:11px 13px;margin:12px 0;color:#14294D"><b>MāshāʾAllāh — a great result!</b> Well done — a strong effort.</div>`;
  return "";
}
function emailHtml(childName: string, mark: number, avg: string) {
  const ms = Number.isInteger(mark) ? String(mark) : String(mark);
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1B2438;max-width:600px;margin:0 auto;font-size:15px;line-height:1.6">
<div style="background:#14294D;color:#fff;padding:16px 18px;border-radius:12px 12px 0 0"><span style="font-family:Georgia,serif;font-size:19px;font-weight:bold">Islamic Studies — Weekly Exam</span><br><span style="color:#C9D3E6;font-size:13px">Al Jamiatul Islamiyah · Bolton Darul Uloom</span></div>
<div style="border:1px solid #E4DECF;border-top:none;border-radius:0 0 12px 12px;padding:18px">
<p><b>Assalāmu ʿalaykum wa raḥmatullāh,</b></p>
<p>As part of our Islamic Studies programme, your son sits a short weekly exam (marked out of 10) covering what he has studied that week. Here is <b>${childName}</b>'s mark for this week's exam:</p>
<table style="border-collapse:collapse;margin:8px 0 4px"><tr><td style="padding:8px 18px 8px 0;font-size:16px"><b>This week</b></td><td style="padding:8px 0;font-weight:bold;color:#14294D;font-size:18px">${ms} / 10</td></tr></table>
<p style="color:#6E6A60;font-size:13px;margin-top:0">Class average this week: ${avg} / 10</p>
${praise(mark)}
<p><b>Why we do this:</b> these weekly exams keep the boys consistently revising, so that the mid-year and end-of-year examinations feel familiar and manageable rather than daunting. Every question comes only from what your son has already covered in class.</p>
<p><b>How you can help:</b> please encourage your son to revise a little each week — <b>especially on Thursday</b> — so he is ready for the exam and can give his best, inshāʾAllāh.</p>
<p style="margin-top:16px">JazākumAllāhu khayran,<br><b style="color:#14294D">Muallim Luqmān Amla</b><br>Islamic Studies — Al Jamiatul Islamiyah</p></div></div>`;
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
    const { data: acc } = await svc.from("staff_access").select("is_full").eq("user_id", user.id).maybeSingle();
    if (!me || (me.role !== "admin" && !(acc && acc.is_full))) return json({ error: "admins only" }, 403);

    const body = await req.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const dryRun = !!body.dry_run;
    // numeric marks only
    const clean = rows.map((r: any) => ({ name: String(r.name || "").trim(), mark: (r.mark === 0 || r.mark) && !isNaN(Number(r.mark)) ? Number(r.mark) : null }))
      .filter((r: any) => r.name && r.mark !== null && r.mark !== "" );
    if (!clean.length) return json({ error: "no marks provided" }, 400);
    const avg = (clean.reduce((s: number, r: any) => s + r.mark, 0) / clean.length).toFixed(1);

    // build pupil + parent lookup
    const pupils = await (async () => { let all: any[] = [], off = 0; while (true) { const { data } = await svc.from("pupils").select("id,first_name,last_name").eq("is_active", true).range(off, off + 999); if (!data || !data.length) break; all = all.concat(data); if (data.length < 1000) break; off += 1000; } return all; })();
    const pmap: Record<string, any> = {};
    pupils.forEach((p) => (pmap[norm(p.first_name + " " + p.last_name)] = p));
    const links = await (async () => { let all: any[] = [], off = 0; while (true) { const { data } = await svc.from("parent_pupil").select("parent_id,pupil_id").range(off, off + 999); if (!data || !data.length) break; all = all.concat(data); if (data.length < 1000) break; off += 1000; } return all; })();
    const byPupil: Record<string, string[]> = {}; links.forEach((l) => (byPupil[l.pupil_id] = byPupil[l.pupil_id] || []).push(l.parent_id));
    const parents = await (async () => { let all: any[] = [], off = 0; while (true) { const { data } = await svc.from("profiles").select("id,email,full_name").eq("role", "parent").range(off, off + 999); if (!data || !data.length) break; all = all.concat(data); if (data.length < 1000) break; off += 1000; } return all; })();
    const profs: Record<string, any> = {}; parents.forEach((p) => (profs[p.id] = p));

    function lev(a: string, b: string) { const m = a.length, n2 = b.length; if (!m) return n2; if (!n2) return m; const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n2).fill(0)]); for (let j = 1; j <= n2; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n2; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return d[m][n2]; }
    const ratio = (a: string, b: string) => { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 0; };
    function match(name: string) {
      const n = norm(name);
      if (pmap[n]) return pmap[n];
      const toks = n.split(" ").filter(Boolean);
      const cands = pupils.filter((p) => { const pn = norm(p.first_name + " " + p.last_name); return toks.every((t) => pn.includes(t)) || (norm(p.first_name) === toks[0] && (toks.length === 1 || pn.includes(toks[toks.length - 1]))); });
      if (cands.length === 1) return cands[0];
      // fuzzy fallback for spelling variants (e.g. Ihsan/Ihsaan)
      let best: any = null, bestScore = 0, second = 0;
      for (const p of pupils) { const s = ratio(n, norm(p.first_name + " " + p.last_name)); if (s > bestScore) { second = bestScore; bestScore = s; best = p; } else if (s > second) second = s; }
      if (bestScore >= 0.82 && bestScore - second >= 0.04) return best;
      return null;
    }

    const cfg: Record<string, string> = {};
    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
    const brevo = cfg.brevo_api_key, sender = cfg.brevo_sender_email || "luqman.amla@boltondarululoom.org.uk";

    let sent = 0; const unmatched: string[] = []; const noParent: string[] = []; const preview: any[] = [];
    for (const r of clean) {
      const pu = match(r.name);
      if (!pu) { unmatched.push(r.name); continue; }
      const emails = (byPupil[pu.id] || []).map((pid) => profs[pid]).filter((p) => p && p.email);
      if (!emails.length) { noParent.push(r.name); continue; }
      preview.push({ name: pu.first_name + " " + pu.last_name, mark: r.mark, to: emails.map((e) => e.email) });
      if (dryRun) continue;
      for (const e of emails) {
        try {
          const resp = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": brevo, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ sender: { name: "Muallim Luqmān Amla", email: sender }, to: [{ email: e.email, name: e.full_name || "Parent" }], replyTo: { email: sender }, subject: "Islamic Studies — Weekly Exam Mark", htmlContent: emailHtml(pu.first_name + " " + pu.last_name, r.mark, avg) }) });
          if (resp.ok) sent++;
        } catch (_) { /* continue */ }
      }
    }
    return json({ ok: true, dry_run: dryRun, class_average: avg, matched: preview.length, sent, unmatched, no_parent: noParent, preview: dryRun ? preview : undefined });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
