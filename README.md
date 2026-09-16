# Al Jamiatul Islamiyah — Parent Hub

Mobile-first parent communication app for Al Jamiatul Islamiyah (Bolton Darul Uloom).

- **Static PWA** (`index.html`, `manifest.json`, `sw.js`, icons) — installable, push notifications.
- Data + auth + realtime + edge functions on Supabase (project `maklrulelurahdlkbsgz`, schema `parent_hub`).
- Announcements: Web Push to everyone (free) + email fallback (Brevo) only for parents without push, and always for Urgent.
- Private parent ↔ school messaging with realtime delivery + push.

## Deploy
Static site — no build step. Vercel serves the repo root as-is.

## Edge functions (deploy separately via Supabase)
- `supabase/functions/send-announcement`
- `supabase/functions/send-message`
