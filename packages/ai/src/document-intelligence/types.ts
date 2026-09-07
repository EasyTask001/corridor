import type { DocumentType, ExtractedDocument } from "@corridor/domain";

export interface DocumentInput {
  /** raw bytes of the uploaded file */
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** what the uploader said it was (may be 'other') */
  declaredType: DocumentType;
}

export interface ExtractorResult {
  /** unvalidated model output — the pipeline validates it against the Zod contract */
  raw: unknown;
  model: string;
  /** provider usage for observability, when available */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface Extractor {
  readonly name: string;
  extract(input: DocumentInput, hint: { documentType: DocumentType }): Promise<ExtractorResult>;
}

export interface PipelineResult {
  ok: true;
  document: ExtractedDocument;
  detectedType: DocumentType;
  model: string;
  confidence: number;
  /** required fields whose confidence fell below the threshold */
  lowConfidenceFields: string[];
  usage?: ExtractorResult["usage"];
}

export interface PipelineFailure {
  ok: false;
  model: string;
  error: string;
  /** validation issues when the model produced structurally invalid output */
  issues?: string[];
}

export type PipelineOutcome = PipelineResult | PipelineFailure;
