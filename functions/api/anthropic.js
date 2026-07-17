/* ============================================================
   Cloudflare Pages Function — proxy seguro a la API de Anthropic (Claude).
   Ruta: /api/anthropic  (POST)
   La API key vive en la variable de entorno ANTHROPIC_API_KEY (cifrada en
   Cloudflare); NUNCA llega al navegador del equipo.
   El navegador solo manda { prompt, maxTokens } y recibe la respuesta de Claude.
   ============================================================ */

const MODEL = 'claude-haiku-4-5-20251001';

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'Falta ANTHROPIC_API_KEY en el entorno' }, 500);
    const { prompt, content, maxTokens } = await request.json();
    // content = bloques (texto + imágenes por URL) para análisis con visión; prompt = texto simple.
    const msgContent = (Array.isArray(content) && content.length) ? content : prompt;
    if (!msgContent) return json({ error: 'Falta prompt o content' }, 400);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens || 256,
        temperature: 0,
        messages: [{ role: 'user', content: msgContent }]
      })
    });
    // Reenvía tal cual la respuesta de Anthropic (mismo cuerpo y código).
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
