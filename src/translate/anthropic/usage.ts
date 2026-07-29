import type { AnthropicUsage } from '../../types/anthropic.js';
import type { ResponsesUsage } from '../../types/responses.js';

/**
 * Map Anthropic-native usage onto the Responses usage contract.
 *
 * WHY the three prompt-side counters are summed — do not "simplify" this back to
 * `usage.input_tokens`:
 *
 * Anthropic reports `input_tokens` as the UNCACHED REMAINDER only. It is disjoint
 * from `cache_read_input_tokens` and `cache_creation_input_tokens`, so on a warm
 * turn a ~480k-token prompt arrives as `input_tokens: ~4k` with the other ~476k
 * parked in the cache counters. The Responses contract means the opposite thing by
 * the same field name: `input_tokens` is the FULL prompt and
 * `input_tokens_details.cached_tokens` is a SUBSET breakdown of it. Reporting the
 * remainder alone therefore under-reports the prompt by one to two orders of
 * magnitude, and breaks the `total_tokens == input_tokens + output_tokens`
 * invariant that Responses consumers rely on.
 *
 * The sibling upstream format already does exactly this: the OpenAI translator
 * (`src/translate/openai/translateResponse.ts`) maps `prompt_tokens` — which
 * already includes cached tokens — straight to `input_tokens`, with
 * `prompt_tokens_details.cached_tokens` as the subset. Two upstream formats behind
 * one output contract have to agree.
 *
 * This is not cosmetic. Downstream context meters and auto-compaction triggers key
 * off `total_tokens` (and pin their compaction-window baseline to `input_tokens`),
 * so an under-reported prompt keeps compaction from ever arming on a long cached
 * conversation.
 *
 * Both the non-streaming and streaming translators call this so the two paths
 * cannot drift; the defect existed in two places because the arithmetic had been
 * written twice.
 */
export function buildResponsesUsage(usage: AnthropicUsage): ResponsesUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = (usage.input_tokens ?? 0) + cacheRead + cacheCreation;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    input_tokens: promptTokens,
    output_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
    },
  };
}
