// 전화중국어 연습실 — AI 연결 서버 함수 (Vercel + Google Gemini 무료 등급)
// API 키는 여기서만 쓰이고, 학생 휴대폰에는 절대 전달되지 않아요.
// Vercel 환경 변수:
//   GEMINI_API_KEY   (필수) Google AI Studio에서 만든 무료 키
//   ACCESS_CODE      (선택) 앱 접속 코드. 정하면 이 코드를 아는 사람만 쓸 수 있어요.
//   MODEL_FAST       (선택) 통화 중 대답 모델 이름을 바꾸고 싶을 때
//   MODEL_SMART      (선택) 교정 노트 모델 이름을 바꾸고 싶을 때
// 모델이 없어졌거나 무료 등급에서 안 되면 목록의 다음 모델로 자동으로 넘어가요.

const CHAIN = {
  quick: [process.env.MODEL_FAST, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'],
  default: [process.env.MODEL_SMART, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'],
};

export const maxDuration = 60; // Vercel 함수 최대 실행 시간(초)

async function callGemini(model, prompt, maxTokens, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r;
  try {
  r = await fetch(url, {
    signal: ctl.signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8, responseMimeType: 'application/json' },
    }),
  });
  } finally { clearTimeout(timer); }
  let j = {};
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, ok: r.ok, j };
}

export default async function handler(req, res) {
  if (req.method === 'GET' && String(req.query?.test || '') === '1') return selfTest(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const need = process.env.ACCESS_CODE;
  if (need && req.headers['x-access-code'] !== need) return res.status(401).json({ error: 'bad_code' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'no_key' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const prompt = String(body.prompt || '');
  const tier = body.tier === 'default' ? 'default' : 'quick';
  if (!prompt || prompt.length > 30000) return res.status(400).json({ error: 'bad_prompt' });

  const models = [...new Set(CHAIN[tier].filter(Boolean))];
  const maxTokens = tier === 'default' ? 8192 : 2048; // 생각하는 데 쓰는 분량까지 넉넉히
  let last = 'api_error';
  const tried = [];
  for (const model of models) {
    try {
      const { status, ok, j } = await callGemini(model, prompt, maxTokens);
      if (!ok) tried.push(`${model}: ${status} ${(j?.error?.message || '').slice(0, 160)}`);
      if (ok) {
        const parts = j?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
        if (text) return res.status(200).json({ text, model });
        last = 'empty';
        tried.push(`${model}: 빈 응답 (${j?.candidates?.[0]?.finishReason || '?'})`);
        continue;
      }
      if (status === 429) { last = 'rate_limited'; continue; } // 이 모델의 무료 한도가 차면 다음 모델로
      if ((status === 400 && /api key/i.test(j?.error?.message || '')) || status === 401 || status === 403) {
        console.error('Gemini key error', tried);
        return res.status(500).json({ error: 'bad_key', detail: tried.join(' | ') });
      }
      last = 'api_error'; // 404(모델 없음) 등은 다음 모델로
    } catch (e) { last = 'network'; tried.push(`${model}: 연결 실패 ${String(e).slice(0, 80)}`); }
  }
  console.error('Gemini failed', tried);
  return res.status(last === 'rate_limited' ? 429 : 502).json({ error: last, detail: tried.join(' | ') });
}

// 진단용: 브라우저에서 /api/chat?test=1&code=접속코드 를 열면 모델별 연결 결과를 보여 줘요.
async function selfTest(req, res) {
  const need = process.env.ACCESS_CODE;
  if (need && String(req.query?.code || '') !== need) return res.status(401).json({ error: '주소 끝에 &code=접속코드 를 붙여 주세요' });
  const key = process.env.GEMINI_API_KEY || '';
  const out = { 키_설정됨: !!key, 키_앞부분: key.slice(0, 4), 키_길이: key.length, 결과: [] };
  const models = [...new Set([...CHAIN.quick, ...CHAIN.default].filter(Boolean))];
  for (const model of models) {
    const t = Date.now();
    try {
      const { status, ok, j } = await callGemini(model, 'Reply ONLY with JSON: {"zh":"你好"}', 256, 12000);
      const text = (j?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      out.결과.push({ model, status, 초: ((Date.now() - t) / 1000).toFixed(1), 답: ok ? text.slice(0, 60) : (j?.error?.message || '').slice(0, 200) });
    } catch (e) {
      out.결과.push({ model, status: '시간초과/연결실패', 초: ((Date.now() - t) / 1000).toFixed(1), 답: String(e).slice(0, 120) });
    }
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.status(200).send(JSON.stringify(out, null, 2));
}
