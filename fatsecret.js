export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });

  try {
    // Step 1: get OAuth2 token
    const tokenRes = await fetch('https://oauth.fatsecret.com/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.FATSECRET_CLIENT_ID,
        client_secret: process.env.FATSECRET_CLIENT_SECRET,
        scope: 'basic'
      })
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error('No token');

    // Step 2: search foods
    const searchRes = await fetch(
      `https://platform.fatsecret.com/rest/server.api?method=foods.search&search_expression=${encodeURIComponent(query)}&format=json&max_results=6`,
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );
    const data = await searchRes.json();
    const foods = data?.foods?.food;
    if (!foods) return res.status(200).json({ results: [] });

    const list = Array.isArray(foods) ? foods : [foods];
    const results = list.map(f => {
      // description format: "Per 100g - Calories: 52kcal | Fat: 0.17g | Carbs: 13.81g | Protein: 0.26g"
      const desc = f.food_description || '';
      const kcal = parseFloat(desc.match(/Calories:\s*([\d.]+)/i)?.[1] || 0);
      const fat  = parseFloat(desc.match(/Fat:\s*([\d.]+)/i)?.[1] || 0);
      const carbs= parseFloat(desc.match(/Carbs:\s*([\d.]+)/i)?.[1] || 0);
      const prot = parseFloat(desc.match(/Protein:\s*([\d.]+)/i)?.[1] || 0);
      return {
        n: f.food_name,
        k: Math.round(kcal),
        p: Math.round(prot * 10) / 10,
        f: Math.round(fat * 10) / 10,
        c: Math.round(carbs * 10) / 10,
        tags: f.food_name.toLowerCase().split(/\s+/),
        portions: [],
        source: 'fatsecret'
      };
    });

    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
