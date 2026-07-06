// Intent-narrative embeddings (spec §3.6). We embed the NL intent narrative, not
// products — the vector captures the semantic shape of the shopper's intent.
//
// Anthropic has no embeddings endpoint, so this uses an OpenAI-COMPATIBLE provider.
// Defaults to OpenAI text-embedding-3-small (1536-dim → matches the pgvector
// column). For another provider set EMBEDDINGS_BASE_URL + EMBEDDINGS_MODEL (and
// make sure its dimension matches the column, or change the schema).
const BASE = process.env.EMBEDDINGS_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";

export const EMBED_DIM = 1536;
export const embeddingsEnabled = () => !!process.env.EMBEDDINGS_API_KEY;

export async function embedText(text: string): Promise<number[] | null> {
  const key = process.env.EMBEDDINGS_API_KEY;
  if (!key || !text.trim()) return null;
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  return json.data?.[0]?.embedding ?? null;
}
