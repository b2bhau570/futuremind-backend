'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    console.error('Invalid JSON body:', error.message);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(error);
});

const PORT = process.env.PORT || 8080;
const SARVAM_API_URL =
  process.env.SARVAM_API_URL || 'https://api.sarvam.ai/v1/chat/completions';
const SARVAM_MODEL = process.env.SARVAM_MODEL || 'sarvam-m';
const FIXED_PESTICIDE_ADVICE = 'Consult nearest agriculture department';
const GENERAL_CROP_CARE =
  'General crop care: maintain hygiene, avoid overwatering, consult agriculture department.';
const HEALTHY_CROP_CARE =
  'The crop appears healthy. Continue balanced watering, field hygiene, and regular monitoring to keep it protected.';
const GENERAL_PREVENTION_TIPS = [
  'Inspect the crop regularly and remove heavily affected leaves early.',
  'Keep tools, trays, and irrigation areas clean to reduce spread.',
  'Avoid overwatering and improve airflow around the crop canopy.',
];
const HEALTHY_PREVENTION_TIPS = [
  'Keep monitoring the crop regularly for any new spots or wilting.',
  'Continue balanced irrigation and avoid long periods of standing moisture.',
  'Maintain field hygiene and use clean tools during pruning or handling.',
];
const KNOWN_DISEASE_PROFILES = [
  { canonical: 'healthy', aliases: ['healthy', 'healthy leaf', 'no disease'] },
  { canonical: 'northern leaf blight', aliases: ['northern leaf blight'] },
  {
    canonical: 'cercospora leaf spot gray leaf spot',
    aliases: ['cercospora leaf spot', 'gray leaf spot', 'grey leaf spot'],
  },
  { canonical: 'common rust', aliases: ['common rust'] },
  { canonical: 'apple scab', aliases: ['apple scab'] },
  { canonical: 'black rot', aliases: ['black rot'] },
  { canonical: 'cedar apple rust', aliases: ['cedar apple rust'] },
  {
    canonical: 'leaf blight isariopsis leaf spot',
    aliases: ['isariopsis leaf spot', 'leaf blight isariopsis leaf spot'],
  },
  { canonical: 'esca black measles', aliases: ['esca', 'black measles'] },
  {
    canonical: 'huanglongbing citrus greening',
    aliases: ['huanglongbing', 'citrus greening'],
  },
  { canonical: 'bacterial spot', aliases: ['bacterial spot'] },
  { canonical: 'early blight', aliases: ['early blight'] },
  { canonical: 'late blight', aliases: ['late blight'] },
  { canonical: 'leaf mold', aliases: ['leaf mold'] },
  { canonical: 'powdery mildew', aliases: ['powdery mildew'] },
  { canonical: 'septoria leaf spot', aliases: ['septoria leaf spot'] },
  {
    canonical: 'spider mites two spotted spider mite',
    aliases: ['spider mites', 'two spotted spider mite', 'two-spotted spider mite'],
  },
  { canonical: 'target spot', aliases: ['target spot'] },
  {
    canonical: 'tomato yellow leaf curl virus',
    aliases: ['tomato yellow leaf curl virus', 'yellow leaf curl virus'],
  },
  {
    canonical: 'tomato mosaic virus',
    aliases: ['tomato mosaic virus', 'mosaic virus'],
  },
  { canonical: 'leaf scorch', aliases: ['leaf scorch'] },
];

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
    error: 'Use POST /get-cure with JSON body: { "disease": "..." }',
  });
});

app.get('/chat', (req, res) => {
  res.status(405).json({
    error: 'Use POST /chat with JSON body: { "disease": "...", "question": "..." }',
  });
});

app.post('/get-cure', async (req, res) => {
  console.log('Incoming /get-cure request:', req.body);

  const diseaseProfile = resolveDiseaseProfile(req.body?.disease);
  console.log(
    'Normalized disease for /get-cure:',
    diseaseProfile.requestedDisease || '(fallback)',
  );

  if (!diseaseProfile.requestedDisease || !diseaseProfile.isKnown) {
    return res.json(buildFallbackCurePlan(''));
  }

  if (diseaseProfile.canonicalDisease === 'healthy') {
    return res.json(buildFallbackCurePlan('healthy'));
  }

  try {
    const response = await requestSarvam({
      systemPrompt:
        'You are an agricultural advisor. Always return strict JSON with keys: cure, prevention, pesticide.',
      userPrompt: buildCurePrompt(diseaseProfile.canonicalDisease),
      temperature: 0.2,
    });

    const rawText = extractModelText(response.data);
    const parsedJson = extractJson(rawText);
    const normalized = normalizeCurePlan(
      parsedJson,
      diseaseProfile.canonicalDisease,
    );

    return res.json({
      cure: normalized.cure,
      prevention: normalized.prevention,
      pesticide: normalized.pesticide,
      preventionTips: normalized.preventionTips,
      pesticides: normalized.pesticides,
    });
  } catch (err) {
    const details = formatErrorDetails(err);
    console.error('Sarvam cure request failed:', details);

    return res.json(buildFallbackCurePlan(diseaseProfile.canonicalDisease));
  }
});

app.post('/chat', handleDiseaseChat);
app.post('/disease-chat', handleDiseaseChat);
app.post('/ask-disease', handleDiseaseChat);

if (require.main === module) {
  startServer();
}

async function handleDiseaseChat(req, res) {
  console.log('Incoming /chat request:', req.body);

  const diseaseProfile = resolveDiseaseProfile(req.body?.disease);
  const question = sanitizeQuestion(req.body?.question);

  if (!question) {
    return res.status(400).json({ error: 'Question required' });
  }

  const disease =
    diseaseProfile.canonicalDisease ||
    diseaseProfile.requestedDisease ||
    'crop disease';
  console.log('Normalized disease for /chat:', disease);

  try {
    const response = await requestSarvam({
      systemPrompt:
        'You are an agricultural AI assistant. Give concise, practical disease-specific guidance for farmers. If the question is high-risk or uncertain, advise consulting a local agriculture expert.',
      userPrompt: buildChatPrompt({ disease, question }),
      temperature: 0.3,
    });

    const rawText = extractModelText(response.data);
    const answer =
      normalizeChatAnswer(rawText) ||
      buildFallbackChatReply({ disease, question });

    return res.json({
      reply: answer,
      answer,
    });
  } catch (error) {
    const details = formatErrorDetails(error);
    console.error('Sarvam chat request failed:', details);

    const fallbackReply = buildFallbackChatReply({ disease, question });
    return res.json({
      reply: fallbackReply,
      answer: fallbackReply,
    });
  }
}

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

async function requestSarvam({ systemPrompt, userPrompt, temperature }) {
  const sarvamApiKey = process.env.SARVAM_API_KEY;
  if (!sarvamApiKey) {
    throw new Error('SARVAM_API_KEY is missing in backend environment.');
  }

  return axios.post(
    SARVAM_API_URL,
    {
      model: SARVAM_MODEL,
      temperature,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
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
}

function buildCurePrompt(disease) {
  return [
    `Disease: ${disease}`,
    'Return strict JSON only.',
    'Response format: {"cure":"...","prevention":["..."],"pesticide":["..."]}',
    'Keep cure concise and field-practical.',
    'List 3-5 prevention points.',
    'List pesticide guidance as a short list.',
  ].join('\n');
}

function buildChatPrompt({ disease, question }) {
  return [
    `Disease: ${disease}`,
    `Farmer question: ${question}`,
    'Answer in plain text.',
    'Keep the answer practical, concise, and disease-specific.',
  ].join('\n');
}

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

function extractDiseaseName(label) {
  if (typeof label !== 'string') {
    return '';
  }

  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return '';
  }

  const normalizedLabel = trimmedLabel
    .replace(/___+/g, ' - ')
    .replace(/_/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalizedLabel.includes(' - ')) {
    return normalizedLabel.split(' - ').pop().trim();
  }

  return normalizedLabel;
}

function normalizeDiseaseLabel(value) {
  const cleaned = sanitizeText(extractDiseaseName(value));
  const normalized = cleaned
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    !normalized ||
    normalized.includes('background') ||
    normalized.includes('unknown') ||
    normalized.includes('not a plant')
  ) {
    return '';
  }

  return normalized;
}

function resolveDiseaseProfile(value) {
  const requestedDisease = normalizeDiseaseLabel(value);
  if (!requestedDisease) {
    return {
      requestedDisease: '',
      canonicalDisease: '',
      isKnown: false,
    };
  }

  let bestMatch = null;
  for (const profile of KNOWN_DISEASE_PROFILES) {
    for (const alias of profile.aliases) {
      if (requestedDisease === alias || requestedDisease.includes(alias)) {
        if (!bestMatch || alias.length > bestMatch.alias.length) {
          bestMatch = {
            alias,
            canonicalDisease: profile.canonical,
          };
        }
      }
    }
  }

  return {
    requestedDisease,
    canonicalDisease: bestMatch ? bestMatch.canonicalDisease : requestedDisease,
    isKnown: Boolean(bestMatch),
  };
}

function sanitizeQuestion(value) {
  return sanitizeText(value, 400);
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

function normalizeCurePlan(raw, disease) {
  const fallback = buildFallbackCurePlan(disease);
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const cure = normalizeString(raw.cure) || fallback.cure;
  const preventionTips = normalizeStringList(
    raw.prevention || raw.preventionTips,
    fallback.preventionTips,
  );
  const pesticides = normalizeStringList(
    raw.pesticide || raw.pesticides,
    fallback.pesticides,
  );

  return {
    cure,
    prevention: preventionTips.join('\n'),
    pesticide: pesticides.join('\n'),
    preventionTips,
    pesticides,
  };
}

function normalizeChatAnswer(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  const parsedJson = extractJson(rawText);
  if (parsedJson && typeof parsedJson === 'object') {
    return (
      normalizeString(parsedJson.reply) ||
      normalizeString(parsedJson.answer) ||
      normalizeString(parsedJson.response) ||
      normalizeString(parsedJson.message)
    );
  }

  return rawText
    .replace(/^```json/i, '')
    .replace(/^```/i, '')
    .replace(/```$/i, '')
    .trim();
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeStringList(value, fallback) {
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
      .slice(0, 6);

    return cleaned.length > 0 ? cleaned : fallback;
  }

  if (typeof value === 'string' && value.trim()) {
    const cleaned = value
      .split(/\r?\n|\|/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6);

    return cleaned.length > 0 ? cleaned : fallback;
  }

  return fallback;
}

function buildFallbackCurePlan(disease) {
  const normalizedDisease = normalizeDiseaseLabel(disease);
  const isHealthyDisease = normalizedDisease === 'healthy';
  const preventionTips = isHealthyDisease
    ? [...HEALTHY_PREVENTION_TIPS]
    : [...GENERAL_PREVENTION_TIPS];
  const pesticides = [FIXED_PESTICIDE_ADVICE];

  if (!normalizedDisease) {
    return {
      cure: GENERAL_CROP_CARE,
      prevention: preventionTips.join('\n'),
      pesticide: pesticides.join('\n'),
      preventionTips,
      pesticides,
    };
  }

  const cure = isHealthyDisease
    ? HEALTHY_CROP_CARE
    : `For ${normalizedDisease}, remove heavily affected leaves, keep the field clean, avoid overwatering, and monitor spread closely.`;

  return {
    cure,
    prevention: preventionTips.join('\n'),
    pesticide: pesticides.join('\n'),
    preventionTips,
    pesticides,
  };
}

function buildFallbackChatReply({ disease, question }) {
  const diseaseLabel = normalizeDiseaseLabel(disease);

  if (diseaseLabel === 'healthy') {
    return `For a healthy crop, regarding "${question}", continue balanced watering, routine monitoring, and field hygiene to keep the plant protected.`;
  }

  return `For ${diseaseLabel || 'crop disease'}: ${question} - Follow proper care, consult local agriculture experts if needed.`;
}

function formatErrorDetails(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (typeof error.response?.data === 'string') {
    return error.response.data;
  }

  if (error.response?.data) {
    return JSON.stringify(error.response.data);
  }

  return error.message || JSON.stringify(error);
}

module.exports = {
  app,
  buildFallbackChatReply,
  buildFallbackCurePlan,
  normalizeDiseaseLabel,
  resolveDiseaseProfile,
  startServer,
};
