/**
 * mcpServer.ts — expose the stable sharp-only extraction pipeline over MCP.
 *
 * Runs as a stdio MCP server (`node dist/mcpServer.js`) so any MCP client can
 * call the deterministic compiler as a tool. It reuses the exact same
 * executeMechanicalExtraction pipeline the HTTP worker uses — no logic fork.
 *
 * Tool: compile_print_panel
 *   { proofUrl, panelTarget, cropBox, targetDimensions, outputPath?, jobId? }
 *   → crops the panel from the master proof, sizes it to exact print pixels,
 *     mirror-extends the bleed, runs the QC gate, uploads to Supabase, and
 *     returns the storage path + resolved dimensions + QC metrics.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { assertRuntimeConfig } from './config.js';
import { executeMechanicalExtraction } from './processor.js';
import { resolveDimensions } from './sizing.js';
import type { CropBox, ExtractionJob, PanelPhysical } from './types.js';

const TOOL_NAME = 'compile_print_panel';

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proofUrl: {
      type: 'string',
      description: 'URL of the multi-view master proof PNG to crop the panel from.',
    },
    panelTarget: {
      type: 'string',
      description: 'Panel identifier/label, e.g. "driver-side". Used as panelId.',
    },
    cropBox: {
      type: 'object',
      additionalProperties: false,
      description: 'Rectangular panel region within the master sheet, in master pixels.',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    targetDimensions: {
      type: 'object',
      additionalProperties: false,
      description: 'Physical panel size. Output pixels are derived: round((in + bleed*2) * dpi).',
      properties: {
        widthInches: { type: 'number' },
        heightInches: { type: 'number' },
        dpi: { type: 'number', description: 'Defaults to 150 if omitted.' },
        bleedInches: { type: 'number', description: 'Defaults to 5 if omitted.' },
      },
      required: ['widthInches', 'heightInches'],
    },
    outputPath: {
      type: 'string',
      description: 'Destination object path in the Supabase bucket. Defaults to panels/<panelTarget>.png.',
    },
    jobId: { type: 'string', description: 'Optional job id for logging/idempotency.' },
  },
  required: ['proofUrl', 'panelTarget', 'cropBox', 'targetDimensions'],
} as const;

interface CompileArgs {
  proofUrl: string;
  panelTarget: string;
  cropBox: CropBox;
  targetDimensions: PanelPhysical;
  outputPath?: string;
  jobId?: string;
}

function toJob(args: CompileArgs): ExtractionJob {
  const jobId = args.jobId?.trim() || `mcp_${args.panelTarget}`;
  const outputPath = args.outputPath?.trim() || `panels/${args.panelTarget}.png`;
  return {
    jobId,
    outputPath,
    source: 'restylepro-url',
    manifest: {
      panelId: args.panelTarget,
      masterArtworkUrl: args.proofUrl,
      physical: args.targetDimensions,
      cropBox: args.cropBox,
      dimensionSource: 'database',
    },
  };
}

const server = new Server(
  { name: 'panelpro-geometry-worker', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        'Deterministically compile a print-ready panel from a multi-view master proof: ' +
        'crop → exact-pixel resize → mirror bleed → QC gate → upload. Returns the storage ' +
        'path, resolved pixel dimensions, and QC metrics. No generative AI; pixel-faithful.',
      inputSchema: INPUT_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL_NAME) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const args = (request.params.arguments ?? {}) as unknown as CompileArgs;

  // Surface obvious sizing errors as a clean tool error before processing.
  resolveDimensions(args.targetDimensions);

  try {
    const result = await executeMechanicalExtraction(toJob(args));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `compile_print_panel failed: ${(err as Error).message}` }],
    };
  }
});

async function main(): Promise<void> {
  assertRuntimeConfig(); // need Supabase creds to upload the compiled panel
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio JSON-RPC stream on stdout.
  console.error('[panelpro-mcp] compile_print_panel ready on stdio');
}

main().catch((err) => {
  console.error('[panelpro-mcp] fatal:', err);
  process.exit(1);
});
