/**
 * aiExtract.ts — AI "proof → flat design" extraction.
 *
 * This is the one step that is NOT deterministic, and it has to be: a flattened
 * 2D proof has the wrap painted onto the truck, broken up by windows/wheels, so
 * the flat design must be *reconstructed*, not crop-recovered. An image model
 * removes the vehicle template and rebuilds the flat wrap graphic; the rest of
 * the pipeline (scale to 150 DPI + 5" mirror bleed) stays deterministic.
 *
 * Provider-pluggable (Gemini / OpenAI). Requires AI_EXTRACT_API_KEY.
 */

import axios from 'axios';
import { config } from './config.js';

/** Locked-down instruction: isolate the flat design, change nothing else. */
export const EXTRACT_PROMPT =
  'Remove the vehicle completely — the truck body, windows, mirrors, wheels, ' +
  'bumpers, all outlines, shadows, and the white background. Output ONLY the ' +
  'flat vehicle-wrap graphic as a clean flat rectangle that fills the entire ' +
  'frame edge to edge. Where the design was hidden behind a window, wheel, or ' +
  'door line, continue the existing pattern to fill the gap. Keep the exact ' +
  'colors, gradients, and artwork — do not redesign, recolor, or add anything.';

export function aiExtractionEnabled(): boolean {
  return Boolean(config.ai.provider && config.ai.apiKey);
}

/** Reconstruct the flat wrap design from a proof image. Returns PNG bytes. */
export async function extractFlatDesign(proofPng: Buffer): Promise<Buffer> {
  if (!config.ai.provider) {
    throw new Error('AI extraction requested but AI_EXTRACT_PROVIDER is not set.');
  }
  if (!config.ai.apiKey) {
    throw new Error('AI extraction requested but AI_EXTRACT_API_KEY is not set.');
  }
  switch (config.ai.provider) {
    case 'gemini':
      return geminiEdit(proofPng);
    case 'openai':
      return openaiEdit(proofPng);
    default:
      throw new Error(`Unsupported AI_EXTRACT_PROVIDER: ${config.ai.provider}`);
  }
}

async function geminiEdit(png: Buffer): Promise<Buffer> {
  const model = config.ai.model || 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.ai.apiKey}`;
  const res = await axios.post(
    url,
    {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
            { text: EXTRACT_PROMPT },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    },
    { timeout: 180_000, headers: { 'content-type': 'application/json' } },
  );
  const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const b64 = p?.inline_data?.data ?? p?.inlineData?.data;
    if (b64) return Buffer.from(b64, 'base64');
  }
  throw new Error('Gemini returned no image (check model name / quota).');
}

async function openaiEdit(png: Buffer): Promise<Buffer> {
  // Node 22 globals: fetch / FormData / Blob — no extra deps.
  const form = new FormData();
  form.append('model', config.ai.model || 'gpt-image-1');
  form.append('prompt', EXTRACT_PROMPT);
  form.append('image', new Blob([png], { type: 'image/png' }), 'proof.png');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    body: form,
  });
  const j = (await res.json()) as { data?: { b64_json?: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(j.error?.message ?? `OpenAI HTTP ${res.status}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image.');
  return Buffer.from(b64, 'base64');
}
