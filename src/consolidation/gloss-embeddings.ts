/**
 * Offline gloss-embedding store for Phase 37 typed predicate edges (D-07, RESEARCH §2).
 *
 * Embeds the 12 PREDICATE_GLOSSES strings ONCE at sleep time via ModelProvider.embed
 * (offline / sleep — Pitfall 4: ONCE, never per-recall) and persists them in the meta
 * table under key `predicate_gloss_embeddings` as a JSON object keyed by predicate,
 * each value a base64-encoded Float32Array.
 *
 * At recall time, loadGlossEmbeddings() deserializes the stored vectors into
 * Record<Predicate, Float32Array> — loaded once at RecallEngine constructor time (Wave 2).
 *
 * Meta-table storage follows RESEARCH Open Question 1 recommendation: ~75 KB total,
 * parsed once at startup, faster than a sidecar .bin file for this corpus size.
 *
 * Zero new runtime dependencies (net-zero dep invariant).
 */
import { PREDICATES, PREDICATE_GLOSSES } from '../model/typed-predicates';
import type { Predicate } from '../model/typed-predicates';
import type { ModelProvider } from '../model/provider';
import type { SemanticStore } from '../db/semantic-store';

/** Meta table key for the persisted gloss embeddings. */
export const GLOSS_EMBEDDINGS_META_KEY = 'predicate_gloss_embeddings';

/**
 * Embed the 12 predicate glosses via ModelProvider.embed and store them in the
 * meta table under GLOSS_EMBEDDINGS_META_KEY.
 *
 * Called ONCE during the offline sleep pass — never during online recall (Pitfall 4).
 * Re-running is safe (idempotent — overwrites the meta row).
 *
 * @param provider - The ModelProvider instance with an embed() capability.
 * @param store    - The SemanticStore instance with getMeta/setMeta access.
 */
export async function embedAndStoreGlosses(
  provider: ModelProvider,
  store: SemanticStore
): Promise<void> {
  const glossStrings = (PREDICATES as readonly string[]).map(
    (pred) => PREDICATE_GLOSSES[pred as Predicate]
  );

  // Embed all 12 gloss strings in a single batch call (offline — Pitfall 4)
  const vecs = await provider.embed(glossStrings);

  // Serialize each Float32Array as a base64 string, keyed by predicate name
  const serialized: Record<string, string> = {};
  for (let i = 0; i < PREDICATES.length; i++) {
    const pred = PREDICATES[i];
    const vec = vecs[i];
    if (!pred || !vec) {
      throw new Error(`gloss-embeddings: missing embedding for predicate index ${i}`);
    }
    serialized[pred] = float32ArrayToBase64(vec);
  }

  // Write to meta table — single JSON blob (RESEARCH Open Question 1 recommendation)
  store.setMeta(GLOSS_EMBEDDINGS_META_KEY, JSON.stringify(serialized));
}

/**
 * Read and deserialize the persisted gloss embeddings from the meta table.
 *
 * Returns a Record mapping each Predicate to its Float32Array embedding,
 * or null if the embeddings have not yet been computed (embedAndStoreGlosses not called).
 *
 * @param store - The SemanticStore instance with getMeta access.
 */
export function loadGlossEmbeddings(
  store: SemanticStore
): Record<Predicate, Float32Array> | null {
  const raw = store.getMeta(GLOSS_EMBEDDINGS_META_KEY);
  if (!raw) return null;

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }

  const result = {} as Record<Predicate, Float32Array>;
  for (const pred of PREDICATES) {
    const b64 = parsed[pred];
    if (!b64) {
      // Stored embeddings are incomplete — treat as not-yet-embedded
      return null;
    }
    result[pred as Predicate] = base64ToFloat32Array(b64);
  }

  return result;
}

// ─── Internal serialization helpers ──────────────────────────────────────────

/** Encode a Float32Array as a base64 string (browser-compatible via Buffer on Node). */
function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return bytes.toString('base64');
}

/** Decode a base64 string back to a Float32Array. */
function base64ToFloat32Array(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64');
  // Ensure alignment: copy to a new ArrayBuffer to guarantee 4-byte alignment
  const aligned = new ArrayBuffer(bytes.length);
  Buffer.from(aligned).set(bytes);
  return new Float32Array(aligned);
}
