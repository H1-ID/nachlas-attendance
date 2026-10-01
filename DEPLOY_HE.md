# פריסה מהירה — v5

1. Supabase: ודא שהסכמה קיימת. לשדרוג v4 אפשר להריץ `supabase/migrations/002_multi_tenant.sql`.
2. Vercel Environment Variables:
   - `DATABASE_URL` (Secret, Transaction Pooler / 6543)
   - `DATABASE_SSL=true`
   - `DB_POOL_MAX=2`
   - `SEED_DEMO=false`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD` (Secret)
   - `JWT_SECRET` (Secret)
   - `ENCRYPTION_KEY` (Secret)
3. אין להגדיר `YEMOT_SYSTEM_NUMBER` או `YEMOT_API_KEY` גלובליים.
4. פרוס ל-Vercel.
5. לאחר כניסה: הגדרות וחיבור → "חיבור מספר ימות". אפשר להשאיר API Key ריק.
