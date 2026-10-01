# פריסה ידנית — Supabase + Vercel

## שלב א — Supabase
1. צור Project חדש בשם `nachlas-attendance`.
2. שמור אצלך את סיסמת מסד הנתונים.
3. פתח SQL Editor -> New query.
4. העתק את כל התוכן של `supabase/migrations/001_schema.sql`, הדבק ולחץ Run.
5. בראש הפרויקט לחץ Connect -> Transaction pooler.
6. העתק את מחרוזת החיבור המלאה והחלף `[YOUR-PASSWORD]` בסיסמת מסד הנתונים. שמור אותה לעצמך; זו `DATABASE_URL`.

## שלב ב — GitHub
1. חלץ את קובץ ה-ZIP.
2. צור Repository חדש, לדוגמה `nachlas-attendance`.
3. העלה את כל תוכן התיקייה שחולצה לשורש ה-Repository.
4. אין להעלות קובץ `.env` עם סודות. הקובץ `.env.example` בטוח כדוגמה.

## שלב ג — Vercel
1. Add New -> Project -> Import Git Repository.
2. בחר את `nachlas-attendance`.
3. השאר Framework Preset כ-Other. אין Build Command ואין Output Directory.
4. לפני Deploy, הוסף Environment Variables ל-Production:
   - DATABASE_URL = מחרוזת Transaction pooler של Supabase
   - DATABASE_SSL = true
   - DB_POOL_MAX = 2
   - JWT_SECRET = מחרוזת אקראית ארוכה
   - ADMIN_EMAIL = כתובת המייל שתשמש לכניסת מנהל
   - ADMIN_PASSWORD = סיסמה חזקה לכניסה ראשונית
   - TZ = Asia/Jerusalem
   - SEED_DEMO = false
   - YEMOT_SYSTEM_NUMBER = 033069364
5. כרגע אל תיצור YEMOT_API_KEY ו-YEMOT_LIVE_ENDPOINT, או השאר אותם ריקים.
6. לחץ Deploy.

## בדיקה
אחרי הפריסה פתח `https://<your-domain>/api/health`.
התוצאה התקינה כוללת `ok: true` ו-`db: true`.
לאחר מכן פתח את הדומיין הראשי והיכנס עם ADMIN_EMAIL / ADMIN_PASSWORD שהגדרת.

## API של ימות בהמשך
כאשר מתקבל API Key מוסיפים אותו רק ב-Vercel -> Project Settings -> Environment Variables, ואז Redeploy. אין לשמור מפתח API בקוד או לשלוח אותו בצ'אט.
