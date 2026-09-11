// Query embedding — deliberately the SAME library, model, options AND
// truncation algorithm the Smart Connections plugin uses to embed documents.
//
// This is the load-bearing correctness decision in the whole server. A query
// embedded by a different model, or the same model with different pooling, lands
// in a different vector space; the dot products still compute, still sort, and
// still return confident-looking nonsense. There is no error to catch.
//
// Taken from the plugin's own model config (smart-connections-obsidian v4.7.2):
//
//   "TaylorAI/bge-micro-v2": {
//     dims: 384, max_tokens: 512, dtype: "auto",
//     semantic_profile: { pooling: "mean", normalize: true,
//                         query_prefix: "", document_prefix: "" }
//   }
//
// Note query_prefix is EMPTY. BGE models are often used with a retrieval prefix
// ("Represent this sentence for searching relevant passages:"), and adding one
// here would shift every query away from the document space. Both prefixes being
// empty also means query and document preparation are the same operation here.
// src/verify.js is the standing check on all of this.
import path from 'node:path';
import os from 'node:os';
import { pipeline, env } from '@huggingface/transformers';

// transformers.js caches the downloaded ONNX weights in
// node_modules/@huggingface/transformers/.cache by default, so `npm ci` deletes
// the model and the next start silently re-downloads ~25MB (or fails, offline).
// HF_HOME does not redirect this — the library reads env.cacheDir. Point it at a
// stable location outside the dependency tree.
env.cacheDir = process.env.SMART_MODEL_CACHE
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'smart-connections-mcp');

const MODEL = process.env.SMART_EMBED_MODEL || 'TaylorAI/bge-micro-v2';
const POOLING = 'mean';
const NORMALIZE = true;
const MAX_TOKENS = 512;

// bge-micro-v2 has 512 learned position embeddings. Longer input does not degrade
// gracefully — it THROWS inside onnxruntime ("Inputs given to model: dims [1, 771]").
//
// The plugin does NOT rely on the tokenizer for this. It truncates the text
// itself first (SmartEmbedAdapter#prepare_input): count tokens, and while over
// budget, cut to 90% of the proportional character estimate and back up to the
// last space. So its stored vector is built from text that is shorter than a
// 512-token cut AND ends on a word boundary. Replicating that matters — measured
// on long blocks, tokenizer-only truncation gives self-similarity as low as
// 0.735 against the stored vector, versus ~0.99 with this algorithm.
//
// The shim below stays as a backstop: transformers.js passes `truncation: true`
// to the tokenizer but truncates against `model_max_length`, which this tokenizer
// ships as **1e+30**, so truncation never fires and an off-by-one in the count
// above would throw instead of degrade. The property is a getter with no backing
// field, so it has to be shadowed on the instance.
let extractor = null;

export async function getExtractor() {
  if (!extractor) {
    // First call downloads the ONNX model (~25MB) and caches it. Local, no API key.
    extractor = await pipeline('feature-extraction', MODEL);
    Object.defineProperty(extractor.tokenizer, 'model_max_length', {
      value: MAX_TOKENS, writable: true, configurable: true,
    });
  }
  return extractor;
}

// Mirrors the adapter's count_tokens: the raw tokenizer call, explicitly NOT
// truncating, so this is the true length. (With the shim above, a truncating
// call would report exactly 512 for anything longer and the loop below would
// never terminate its first check.)
async function countTokens(ex, text) {
  const { input_ids } = await ex.tokenizer(text, { truncation: false, padding: false });
  return input_ids.data.length;
}

// SmartEmbedAdapter#prepare_input, verbatim (prefix omitted: it is '' for both
// purposes on this model).
export async function prepareInput(text) {
  const ex = await getExtractor();
  let tokens = await countTokens(ex, text);
  if (tokens <= MAX_TOKENS) return { text, tokens };

  let truncated = text;
  while (tokens > MAX_TOKENS && truncated.length > 0) {
    const pct = MAX_TOKENS / tokens;
    const maxChars = Math.floor(truncated.length * pct * 0.9);
    truncated = truncated.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) truncated = truncated.slice(0, lastSpace);
    tokens = await countTokens(ex, truncated);
  }
  return { text: truncated, tokens };
}

export async function embedQuery(text) {
  const ex = await getExtractor();
  const prepared = await prepareInput(text);
  const out = await ex(prepared.text, { pooling: POOLING, normalize: NORMALIZE });
  return Float32Array.from(out.data);
}

export const embedInfo = {
  model: MODEL, pooling: POOLING, normalize: NORMALIZE,
  queryPrefix: '', maxTokens: MAX_TOKENS, cacheDir: env.cacheDir,
};
