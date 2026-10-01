import app, { dbReady } from '../src/app.mjs';

export default async function handler(req, res) {
  await dbReady;
  return app(req, res);
}
