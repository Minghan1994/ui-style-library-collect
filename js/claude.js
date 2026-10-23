// The only module that talks to Claude. The SDK bundle is loaded on first use.

const MODEL = 'claude-opus-5-5';

let sdk;
const loadSdk = () => (sdk ??= import('./vendor/anthropic-sdk.js'));

/** Inline images as base64 content blocks. */
async function imageBlock(blob) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { type: 'image', source: { type: 'base64', media_type: blob.type, data } };
}

// The schema comes from the library itself, so tags can only be values in
// taxonomy.yml and sections are exactly the template's headings.
function analysisSchema({ groups, sections, fitOptions }) {
  const object = (properties) => ({
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
  });
  return object({
    title: { type: 'string', description: 'Short, specific case title, e.g. "Fleet table with status chips".' },
    product: { type: 'string', description: 'Product name if it can be identified from the screenshots, else "".' },
    tags: object(Object.fromEntries(groups.map((g) => [g.key, {
      type: 'array',
      items: { type: 'string', enum: g.values.map((v) => v.value) },
      description: g.hint || (g.multi ? 'Pick any that apply.' : 'Pick 1.'),
    }]))),
    fit_with_baseline: { type: 'string', enum: fitOptions },
    sections: object(Object.fromEntries(sections.map((s) => [s.heading, { type: 'string', description: s.hint }]))),
  });
}

/**
 * Drafts a case from screenshots.
 * guide: { prompt, design, taxonomy } — the library's own instructions and references.
 * Returns { title, product, tags, fit, sections }.
 */
export async function analyzeScreenshots({ apiKey, images, guide, groups, sections, fitOptions }) {
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let response;
  try {
    response = await requestAnalysis(client, { images, guide, groups, sections, fitOptions });
  } catch (e) {
    throw new Error(describeError(Anthropic, e), { cause: e });
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to analyze these screenshots.');
  if (response.stop_reason === 'max_tokens') throw new Error('The analysis was cut off. Try fewer screenshots.');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no analysis. Try again.');
  const result = JSON.parse(text);

  // Array length limits aren't enforceable in the schema; apply them here.
  const tags = Object.fromEntries(groups.map((g) => [g.key, [...new Set(result.tags[g.key] || [])].slice(0, g.limit)]));
  return { title: result.title, product: result.product, tags, fit: result.fit_with_baseline, sections: result.sections };
}

async function requestAnalysis(client, { images, guide, groups, sections, fitOptions }) {
  return client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: analysisSchema({ groups, sections, fitOptions }) },
    },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [
      guide.prompt,
      'Output format: return JSON matching the provided schema instead of a markdown file. '
        + 'Each `sections` value is the markdown body for that heading, without the heading or its comment; '
        + 'use "" for a section that does not apply. Use bullet lists for list-like sections.',
      `<taxonomy.yml>\n${guide.taxonomy}\n</taxonomy.yml>`,
      `<DESIGN.md>\n${guide.design}\n</DESIGN.md>`,
    ].join('\n\n'),
    messages: [{
      role: 'user',
      content: [
        ...(await Promise.all(images.map(imageBlock))),
        { type: 'text', text: 'Analyze these screenshots for a new visual case.' },
      ],
    }],
  });
}

// Most specific first; anything else keeps the API's own message.
function describeError(Anthropic, e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The Anthropic API key is invalid. Paste a new one.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This Anthropic API key is not allowed to use the model.';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached. Wait a minute and try again.';
  if (e instanceof Anthropic.InternalServerError) return 'Anthropic is having trouble right now. Try again shortly.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your connection.';
  if (e instanceof Anthropic.APIError) return `Anthropic: ${e.error?.error?.message || e.message}`;
  return e.message;
}
