import 'dotenv/config';
const PORT = Number(process.env.PORT || 3000);
const { app, dbReady } = await import('./app.mjs');
await dbReady;
app.listen(PORT, () => console.log(`NACHLAS Attendance v5 listening on http://localhost:${PORT}`));
