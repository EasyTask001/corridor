/**
 * Simple sentence-aware chunker. Regulation summaries here are short enough
 * (a few hundred words) that most become one or two chunks — good enough for
 * demonstrating retrieval without pulling in a tokenizer dependency.
 */
export function chunkText(text: string, maxChars = 500): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}
