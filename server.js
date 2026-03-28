'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8080;
const SARVAM_API_URL = process.env.SARVAM_API_URL || 'https://api.sarvam.ai/v1/chat/completions';
const SARVAM_MODEL = process.env.SARVAM_MODEL || 'sarvam-m';
const FIXED_PESTICIDE_ADVICE = 'Consult nearest agriculture department';

app.get('/', (req, res) => {
  res.send('Backend running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/test', (req, res) => {
  res.json({
    message: 'Backend working',
  });
});

app.get('/get-cure', (req, res) => {
  res.status(405).json({
    error: 'Use POST /get-cure with JSON body: { "disease": "...", "crop": "..." }',
  });
});

app.post('/get-cure', async (req, res) => {
  console.log('Incoming request:', req.body);

  const { disease, crop } = req.body || {};
  const safeDisease = sanitizeText(disease);
  const safeCrop = sanitizeText(crop);

  if (!safeDisease || !safeCrop) {
    return res.status(400).json({ error: 'Missing data' });
  }

  const sarvamApiKey = process.env.SARVAM_API_KEY;
  if (!sarvamApiKey) {
    return res.status(500).json({
      error: 'SARVAM_API_KEY is missing in backend environment.',
    });
  }

  try {
    const prompt = buildPrompt({ disease: safeDisease, crop: safeCrop });

    const response = await axios.post(
      SARVAM_API_URL,
      {
        model: SARVAM_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are an agricultural advisor. Always answer in strict JSON format with keys: cure, pesticides, preventionTips.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      },
      {
        timeout: 25000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sarvamApiKey}`,
          'api-subscription-key': sarvamApiKey,
        },
      },
    );

    const rawText = extractModelText(response.data);
    const parsedJson = extractJson(rawText);
    const normalized = normalizePlan(parsedJson, safeDisease, safeCrop);

    return res.json({
      cure: normalized.cure || 'No cure information available right now.',
      pesticides: [FIXED_PESTICIDE_ADVICE],
      preventionTips:
        normalized.preventionTips.length > 0
          ? normalized.preventionTips
          : ['Keep crop area clean and monitor leaves regularly.'],
    });
  } catch (err) {
    const details =
      typeof err.response?.data === 'string'
        ? err.response.data
        : JSON.stringify(err.response?.data || {});
    console.error('Sarvam request failed:', details);

    return res.status(500).json({
      error: 'Failed to get cure',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function buildPrompt({ disease, crop }) {
  return [
    `Disease: ${disease}`,
    `Crop: ${crop}`,
    'Return strict JSON only. Example:',
    '{"cure":"...","pesticides":["..."],"preventionTips":["..."]}',
    'Keep cure concise and practical for field use.',
    'List 3-5 prevention tips.',
  ].join('\n');
}

function sanitizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, 120);
}

function extractModelText(payload) {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload?.choices?.[0]?.message?.content) {
    return payload.choices[0].message.content;
  }

  if (payload?.output?.[0]?.content?.[0]?.text) {
    return payload.output[0].content[0].text;
  }

  if (typeof payload?.response === 'string') {
    return payload.response;
  }

  return JSON.stringify(payload || {});
}

function extractJson(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function normalizePlan(raw, disease, crop) {
  const fallback = fallbackPlan(disease, crop);
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const cure = normalizeString(raw.cure) || fallback.cure;
  const preventionTips = normalizeStringList(raw.preventionTips, fallback.preventionTips);

  return {
    cure,
    pesticides: [FIXED_PESTICIDE_ADVICE],
    preventionTips,
  };
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const cleaned = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 6);

  return cleaned.length > 0 ? cleaned : fallback;
}

function fallbackPlan(disease, crop) {
  return {
    cure:
      `Isolate affected ${crop} leaves, remove heavily infected tissue, and start a crop-safe treatment plan for ${disease}.`,
    pesticides: [FIXED_PESTICIDE_ADVICE],
    preventionTips: [
      'Avoid overhead irrigation and reduce prolonged leaf wetness.',
      'Improve airflow with proper spacing and pruning.',
      'Inspect crop every 2-3 days and remove infected leaves early.',
    ],
  };
}
