/**
 * Types for Transcript Correction functionality
 */

export interface CorrectionRule {
  incorrect: string;
  correct: string;
  caseSensitive?: boolean;
}

export interface ReplacementDetail {
  rule: string;
  count: number;
}

export interface CorrectionStats {
  totalChunksProcessed: number;
  chunksModified: number;
  totalReplacements: number;
  processingTimeMs: number;
  replacementDetails: ReplacementDetail[];
}

export interface CorrectionResponse {
  success: boolean;
  message: string;
  dryRun: boolean;
  videoId?: string;
  stats: CorrectionStats;
  errors?: string[];
}

export interface CorrectionRulesResponse {
  success: boolean;
  rules: CorrectionRule[];
  description: string;
}

export interface PreviewCorrectionRequest {
  text: string;
  correctionRules?: CorrectionRule[];
}

export interface PreviewCorrectionResponse {
  success: boolean;
  originalText: string;
  correctedText: string;
  hasChanges: boolean;
  replacements: ReplacementDetail[];
}

export interface CorrectionRequest {
  videoId?: string;
  correctionRules?: CorrectionRule[];
  dryRun?: boolean;
}

