/**
 * Surgical sub-surface inpainting.
 *
 * AI is allowed here and NOWHERE ELSE in the pipeline. It only ever sees the
 * flat cropped asset plus a binary mask of physically occluded voids (door
 * handles, mirrors, wheel wells). It is forbidden — by prompt and by
 * temperature 0.0 — from redesigning, recoloring, or shifting gradients.
 *
 * This module is intentionally provider-pluggable and is a no-op when no
 * provider is configured, so the worker can run in pure mechanical mode.
 */

import { config } from './config';

/** Constant, locked-down repair instruction. Do not soften this wording. */
export const INPAINT_PROMPT =
  'Continue the existing artwork exactly across this void. ' +
  'Do not change colors, do not alter gradients, do not redesign.';

export interface InpaintRequest {
  /** Flat cropped asset, PNG bytes (8-bit RGBA). */
  image: Buffer;
  /** Binary mask, PNG bytes: white = repair, black = keep. Same dimensions. */
  mask: Buffer;
  width: number;
  height: number;
}

/**
 * Returns the repaired image bytes, or the original image untouched when AI is
 * disabled. Keeping this contract total means callers never branch on config.
 */
export async function inpaintVoids(req: InpaintRequest): Promise<Buffer> {
  if (!config.inpaint.provider) {
    // Pure mechanical mode — leave voids exactly as BORDER_REPLICATE left them.
    return req.image;
  }

  switch (config.inpaint.provider) {
    case 'gemini':
      return callGemini(req);
    case 'openai':
      return callOpenAi(req);
    default:
      throw new Error(`Unsupported inpaint provider: ${config.inpaint.provider}`);
  }
}

/**
 * Provider adapters are stubbed with the exact contract the geometry pipeline
 * expects. Wire the real HTTP call in here; the surrounding pipeline, masking,
 * and QC gate do not change.
 */
async function callGemini(req: InpaintRequest): Promise<Buffer> {
  assertKey();
  // TODO: POST { image, mask, prompt: INPAINT_PROMPT, temperature: 0.0 }
  // to the Gemini image edit endpoint and return the decoded PNG bytes.
  throw new Error('Gemini inpaint adapter not yet wired. Set INPAINT_PROVIDER= to disable.');
}

async function callOpenAi(req: InpaintRequest): Promise<Buffer> {
  assertKey();
  // TODO: POST image+mask to the GPT Image edit endpoint with temperature 0.0.
  throw new Error('OpenAI inpaint adapter not yet wired. Set INPAINT_PROVIDER= to disable.');
}

function assertKey(): void {
  if (!config.inpaint.apiKey) {
    throw new Error('INPAINT_API_KEY is required when an inpaint provider is set.');
  }
  if (config.inpaint.temperature !== 0.0) {
    throw new Error('Inpainting must run at temperature 0.0 for deterministic fidelity.');
  }
}
