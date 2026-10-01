# NACHLAS Attendance v5 — Multi-Tenant / Multi-System

מערכת נוכחות אינטרנטית לימות המשיח, בנויה ל-Vercel + Supabase.

## מה חדש ב-v5
- הפרדת נתונים מלאה לפי ארגון.
- משתמש יכול להשתייך ליותר מארגון אחד ולעבור ביניהם.
- כל ארגון יכול לחבר כמה מספרי ימות המשיח.
- כל שיעור משויך למספר ימות מסוים + שלוחה.
- API Key הוא אופציונלי: אפשר להקים את כל המערכת גם לפני שקיבלת API.
- API Key עתידי נשמר מוצפן במסד בעזרת `ENCRYPTION_KEY`, ואינו מוחזר לדפדפן.
- אין יותר `YEMOT_SYSTEM_NUMBER` או `YEMOT_API_KEY` גלובליים ב-Vercel.

## משתני סביבה נדרשים
- `DATABASE_URL`
- `DATABASE_SSL=true`
- `DB_POOL_MAX=2`
- `SEED_DEMO=false`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `JWT_SECRET`
- `ENCRYPTION_KEY` — נדרש לפני שמירת API Key של ימות.

אין צורך ב-`TZ`; המערכת משתמשת ב-`Asia/Jerusalem` כברירת מחדל פנימית.

## שדרוג מ-v4
הקובץ `supabase/migrations/002_multi_tenant.sql` ממיר את הנתונים הישנים לארגון ראשי ושומר את הנתונים הקיימים.
האפליקציה מריצה את המיגרציה בצורה idempotent גם באתחול, אך אפשר להריץ אותה ידנית ב-Supabase SQL Editor לפני הפריסה.

## LIVE
כרגע ניתן לשמור מספרי ימות בלי API. מסך LIVE יישאר במצב "ממתין ל-API" עד שיתקבל API Key ונחבר את מתאם `GetIncomingCalls` לפורמט הרשמי.
