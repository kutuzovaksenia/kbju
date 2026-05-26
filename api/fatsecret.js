export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });

  try {
    // Search Open Food Facts — try Russian first, then English translation
    async function searchOFF(q, lang) {
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=6&lc=${lang}&fields=product_name,product_name_ru,nutriments,serving_size,brands`;
      const r = await fetch(url, { headers: { 'User-Agent': 'KBJUTracker/1.0' } });
      const d = await r.json();
      return d?.products || [];
    }

    // Try Russian query first
    let products = await searchOFF(query, 'ru');

    // If not enough results, also try English translation
    if (products.length < 3) {
      const translateRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 40,
          system: 'Translate Russian food name to English, 1-3 words max. Return ONLY the translation.',
          messages: [{ role: 'user', content: query }]
        })
      });
      const td = await translateRes.json();
      const enQuery = td.content?.[0]?.text?.trim();
      if (enQuery && enQuery !== query) {
        const enProducts = await searchOFF(enQuery, 'en');
        // Merge, deduplicate by product name
        const seen = new Set(products.map(p => p.product_name));
        for (const p of enProducts) {
          if (!seen.has(p.product_name)) { products.push(p); seen.add(p.product_name); }
        }
      }
    }

    // Filter products that have nutritional data
    const valid = products.filter(p => {
      const n = p.nutriments;
      return n && (n['energy-kcal_100g'] || n['energy-kcal']) && p.product_name;
    }).slice(0, 6);

    if (valid.length === 0) {
      return res.status(200).json({ results: [] });
    }

    // Translate names to Russian if needed
    const names = valid.map(p => p.product_name_ru || p.product_name);
    const needsTranslation = names.some(n => !/[а-яё]/i.test(n));

    let namesRu = names;
    if (needsTranslation) {
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
          system: 'Translate food product names to Russian. One per line, same order. Keep brand names as-is. If already Russian, keep as-is.',
          messages: [{ role: 'user', content: names.join('\n') }]
        })
      });
      const nd = await namesRes.json();
      namesRu = (nd.content?.[0]?.text || names.join('\n')).trim().split('\n').map(s => s.trim());
    }

    const results = valid.map((p, i) => {
      const n = p.nutriments;
      const kcal = n['energy-kcal_100g'] || n['energy-kcal_serving'] || 0;
      const prot = n['proteins_100g'] || 0;
      const fat  = n['fat_100g'] || 0;
      const carbs= n['carbohydrates_100g'] || 0;
      const fiber= n['fiber_100g'] || 0;
      const name = namesRu[i] || p.product_name;
      const brand = p.brands ? ` (${p.brands.split(',')[0].trim()})` : '';
      return {
        n: name + (p.brands && !name.toLowerCase().includes(p.brands.split(',')[0].toLowerCase()) ? brand : ''),
        k: Math.round(kcal),
        p: Math.round(prot * 10) / 10,
        f: Math.round(fat * 10) / 10,
        c: Math.round(carbs * 10) / 10,
        fi: Math.round(fiber * 10) / 10,
        tags: name.toLowerCase().split(/\s+/),
        portions: [],
        source: 'openfoodfacts'
      };
    });

    res.status(200).json({ results });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
