# נחל״ס — מערכת נוכחות מחדרי ועידה

גרסה מלאה ראשונה לפריסה כאתר רב־משתמשים.

## על מה זה אמור לשבת?

ההמלצה הפשוטה ביותר כרגע:

**Render Web Service + Render PostgreSQL**

האתר כולו (Frontend + Backend) רץ כתהליך Node.js אחד, ומסד הנתונים ב־PostgreSQL. כך לא צריך להחזיק מחשב שרת בישיבה, וכל מחשב מורשה נכנס לכתובת HTTPS רגילה.

אפשר להריץ את אותו פרויקט גם ב־Railway/Fly.io/VPS/Docker. העיקר: Node.js 20+ ו־PostgreSQL.

## מה כבר כלול

- מסך כניסה והרשאות: מנהל, מזכירות, ר״מ/אחראי שיעור, צפייה.
- Dashboard עם מחוברים LIVE, נוכחים, חסרים וממוצע דקות.
- LIVE שמתעדכן כל 5 שניות.
- תלמידים: הוספה ידנית וייבוא Excel/CSV.
- שיעורים ושלוחות: למשל שיעור ב → `07/1/2`.
- חישוב נוכחות לפי זמן שהייה, סף איחור ומינימום דקות.
- דוחות יומיים/טווח תאריכים.
- משתמשים והרשאות.
- Audit log בצד השרת.
- Collector endpoint לשלב הנוכחי, בלי API של נחל״ס.
- מקום מוכן לחיבור Yemot API ישיר בהמשך.

## פריסה ב־Render

1. העלה את התיקייה ל־GitHub.
2. ב־Render בחר `New > Blueprint` והפנה ל־repository. הקובץ `render.yaml` ייצור Web Service + PostgreSQL.
3. הוסף Environment Variables:
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `YEMOT_SYSTEM_NUMBER=033069364`
   - `JWT_SECRET` ו־`COLLECTOR_SECRET` כבר יכולים להיווצר אוטומטית דרך ה־Blueprint, אבל אפשר להחליף לערכים משלך.
4. `DATABASE_URL` מתקבל אוטומטית מה־PostgreSQL של Render.
5. אחרי הפריסה היכנס עם `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## הרצה מקומית

הדרך הקלה:

```bash
docker compose up --build
```

ואז פתח:

```text
http://localhost:3000
```

ברירת המחדל המקומית ב־docker-compose:

- אימייל: `admin@example.com`
- סיסמה: `ChangeMe123!`

שנה אותם לפני שימוש אמיתי.

## Collector — עד שיהיה API

האתר מקבל snapshot של שיחות פעילות ב:

```text
POST /api/collector/push
```

Header:

```text
X-Collector-Secret: <COLLECTOR_SECRET>
```

Body לדוגמה:

```json
{
  "snapshot": true,
  "source": "pitronai-browser",
  "calls": [
    {
      "callId": "abc123",
      "phone": "0500000001",
      "extension": "07/1/2",
      "enteredAt": "2026-10-01T08:30:00+03:00"
    }
  ]
}
```

כאשר `snapshot=true`, שיחה שהייתה פתוחה ב־snapshot הקודם ונעלמה מהחדש תיסגר אוטומטית ותישמר עם זמן יציאה ומשך.

## חיבור Yemot API בעתיד

לא לשים את מפתח ה־API בקוד או בדפדפן. שמור אותו ב־Environment Variables של השרת:

```text
YEMOT_LIVE_ENDPOINT=...
YEMOT_API_KEY=...
YEMOT_SYSTEM_NUMBER=033069364
```

ה־UI כבר בנוי. נשאר רק להתאים את adapter של `GetIncomingCalls` לפורמט האימות והתגובה של המפתח שתקבל.

## הערת אבטחה

- לעולם לא לשלוח API Key ל־frontend.
- `JWT_SECRET` ו־`COLLECTOR_SECRET` צריכים להיות סודות ארוכים ואקראיים.
- בייצור השתמש תמיד ב־HTTPS.
- מומלץ להחליף מיד את סיסמת המנהל הראשונית.
