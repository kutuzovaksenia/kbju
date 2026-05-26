export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });

  try {
    // Step 1: Translate to English
    const translateRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        system: 'Translate this Russian food name to English (2-4 words max). Return ONLY the translation.',
        messages: [{ role: 'user', content: query }]
      })
    });
    const translateData = await translateRes.json();
    const englishQuery = translateData.content?.[0]?.text?.trim() || query;
    console.log('englishQuery:', englishQuery);

    // Step 2: OAuth token
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

    // Step 3: Search
    const searchRes = await fetch(
      `https://platform.fatsecret.com/rest/server.api?method=foods.search&search_expression=${encodeURIComponent(englishQuery)}&format=json&max_results=6`,
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );
    const data = await searchRes.json();
    console.log('FatSecret raw:', JSON.stringify(data).slice(0, 500));

    const foods = data?.foods?.food;
    if (!foods) {
      // Try searching in Russian directly as fallback
      const searchRes2 = await fetch(
        `https://platform.fatsecret.com/rest/server.api?method=foods.search&search_expression=${encodeURIComponent(query)}&format=json&max_results=6`,
        { headers: { Authorization: `Bearer ${token.access_token}` } }
      );
      const data2 = await searchRes2.json();
      console.log('FatSecret RU raw:', JSON.stringify(data2).slice(0, 300));
      if (!data2?.foods?.food) {
        return res.status(200).json({ results: [], debug: { englishQuery, raw: JSON.stringify(data).slice(0,200) } });
      }
    }

    const list = Array.isArray(foods) ? foods : [foods];
    console.log('First food item:', JSON.stringify(list[0]));

    // Step 4: Translate names back to Russian
    const namesEn = list.map(f => f.food_name).join('\n');
    const namesRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: 'Translate food product names from English to Russian. One per line, same order. Keep brand names as-is.',
        messages: [{ role: 'user', content: namesEn }]
      })
    });
    const namesData = await namesRes.json();
    const namesRu = (namesData.content?.[0]?.text || namesEn).trim().split('\n');

    const results = list.map((f, i) => {
      const desc = f.food_description || '';
      console.log('desc:', desc);
      const kcal = parseFloat(desc.match(/Calories:\s*([\d.]+)/i)?.[1] || 0);
      const fat  = parseFloat(desc.match(/Fat:\s*([\d.]+)/i)?.[1] || 0);
      const carbs= parseFloat(desc.match(/Carbs:\s*([\d.]+)/i)?.[1] || 0);
      const prot = parseFloat(desc.match(/Protein:\s*([\d.]+)/i)?.[1] || 0);
      return {
        n: namesRu[i]?.trim() || f.food_name,
        k: Math.round(kcal),
        p: Math.round(prot * 10) / 10,
        f: Math.round(fat * 10) / 10,
        c: Math.round(carbs * 10) / 10,
        tags: (namesRu[i] || f.food_name).toLowerCase().split(/\s+/),
        portions: [],
        source: 'fatsecret'
      };
    });

    res.status(200).json({ results, debug: { englishQuery } });
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
