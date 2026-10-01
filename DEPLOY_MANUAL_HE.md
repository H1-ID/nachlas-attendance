# NACHLAS Attendance v5 — התקנה ידנית

## Supabase
אם כבר הרצת את v4, פתח SQL Editor והריץ את:
`supabase/migrations/002_multi_tenant.sql`

המיגרציה מוסיפה ארגונים, שיוכי משתמשים ומערכות ימות, ומשייכת את הנתונים הקיימים לארגון הראשי.

## Vercel
הגדר ב-Production:
- `DATABASE_URL` — Secret — Transaction Pooler של Supabase, בדרך כלל פורט 6543.
- `DATABASE_SSL` — Config — `true`
- `DB_POOL_MAX` — Config — `2`
- `SEED_DEMO` — Config — `false`
- `ADMIN_EMAIL` — Config
- `ADMIN_PASSWORD` — Secret
- `JWT_SECRET` — Secret
- `ENCRYPTION_KEY` — Secret

אין צורך להגדיר `TZ`, ואין להגדיר מספר ימות או API Key כמשתנה גלובלי.

## מודל החיבור
כל ארגון שומר מספרי ימות משלו בטבלת `yemot_systems`. ניתן להוסיף מספר בלי API Key. כאשר מתקבל API Key הוא נשמר מוצפן לכל מספר בנפרד.
