# פריסה: Vercel + Supabase

## 1. Supabase
צרו Project חדש ונפרד למערכת נחל״ס (מומלץ לא לערבב עם `team-system`).

ב-SQL Editor הריצו את:
`supabase/migrations/001_schema.sql`

לאחר מכן העתיקו **Transaction pooler connection string** מ-Project Settings / Database.
זה הערך של `DATABASE_URL`. אל תכניסו אותו לקוד ואל תשלחו אותו בצ'אט.

## 2. Vercel
צרו Project מהקוד הזה והגדירו Environment Variables:
- `DATABASE_URL`
- `DATABASE_SSL=true`
- `DB_POOL_MAX=2`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `TZ=Asia/Jerusalem`
- `SEED_DEMO=false`

לאחר Deploy בדקו:
`/api/health`
אמור להחזיר `ok: true` ו-`db: true`.

## 3. Yemot
כרגע משאירים ריק:
- `YEMOT_API_KEY`
- `YEMOT_LIVE_ENDPOINT`

כאשר יתקבל API Key, מוסיפים אותם ב-Vercel Environment Variables בלבד. אין לשמור מפתח בקוד או בדפדפן.
