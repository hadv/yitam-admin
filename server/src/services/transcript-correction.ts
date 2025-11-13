import { DatabaseService } from '../core/database-service';
import { createEmbedding } from './embedding';

/**
 * Interface for spelling correction rules
 */
export interface CorrectionRule {
  incorrect: string;
  correct: string;
  caseSensitive?: boolean;
}

/**
 * Default correction rules for Buddhist terminology in Vietnamese
 */
export const DEFAULT_BUDDHIST_CORRECTIONS: CorrectionRule[] = [
  { incorrect: 'dính mắt', correct: 'dính mắc', caseSensitive: false },
  { incorrect: 'rộng lặng', correct: 'rỗng lặng', caseSensitive: false },
];

/**
 * Statistics for correction operation
 */
export interface CorrectionStats {
  totalChunksProcessed: number;
  chunksModified: number;
  totalReplacements: number;
  replacementsByRule: Map<string, number>;
  errors: string[];
  processingTimeMs: number;
}

/**
 * Service for correcting spelling mistakes in transcript chunks
 */
export class TranscriptCorrectionService {
  private dbService: DatabaseService;

  constructor() {
    this.dbService = new DatabaseService();
  }

  /**
   * Apply correction rules to text content
   */
  private applyCorrections(
    text: string,
    rules: CorrectionRule[]
  ): { correctedText: string; replacements: Map<string, number> } {
    let correctedText = text;
    const replacements = new Map<string, number>();

    for (const rule of rules) {
      const flags = rule.caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(rule.incorrect, flags);
      
      // Count occurrences
      const matches = text.match(regex);
      const count = matches ? matches.length : 0;
      
      if (count > 0) {
        correctedText = correctedText.replace(regex, rule.correct);
        replacements.set(`${rule.incorrect} → ${rule.correct}`, count);
      }
    }

    return { correctedText, replacements };
  }

  /**
   * Correct spelling mistakes in all transcript chunks
   */
  async correctAllTranscripts(
    correctionRules: CorrectionRule[] = DEFAULT_BUDDHIST_CORRECTIONS,
    filter?: any,
    dryRun: boolean = false
  ): Promise<CorrectionStats> {
    const startTime = Date.now();
    const stats: CorrectionStats = {
      totalChunksProcessed: 0,
      chunksModified: 0,
      totalReplacements: 0,
      replacementsByRule: new Map(),
      errors: [],
      processingTimeMs: 0
    };

    try {
      console.log(`Starting transcript correction (dry run: ${dryRun})...`);
      console.log(`Correction rules: ${correctionRules.length}`);

      // Get all chunks from database
      const chunks = await this.dbService.getAllChunksWithPointIds(filter);
      console.log(`Retrieved ${chunks.length} chunks for processing`);

      const updates: Array<{
        pointId: string;
        chunkId: string;
        content: string;
        enhancedContent?: string;
        title?: string;
        summary?: string;
        embedding: number[];
      }> = [];

      // Process each chunk
      for (const chunk of chunks) {
        stats.totalChunksProcessed++;

        // Apply corrections to content
        const contentResult = this.applyCorrections(chunk.content, correctionRules);

        // Apply corrections to enhancedContent if it exists
        let enhancedContentResult = null;
        if (chunk.enhancedContent) {
          enhancedContentResult = this.applyCorrections(chunk.enhancedContent, correctionRules);
        }

        // Apply corrections to title if it exists
        let titleResult = null;
        if (chunk.title) {
          titleResult = this.applyCorrections(chunk.title, correctionRules);
        }

        // Apply corrections to summary if it exists
        let summaryResult = null;
        if (chunk.summary) {
          summaryResult = this.applyCorrections(chunk.summary, correctionRules);
        }

        // Check if any changes were made
        const contentChanged = contentResult.correctedText !== chunk.content;
        const enhancedContentChanged = enhancedContentResult &&
          enhancedContentResult.correctedText !== chunk.enhancedContent;
        const titleChanged = titleResult &&
          titleResult.correctedText !== chunk.title;
        const summaryChanged = summaryResult &&
          summaryResult.correctedText !== chunk.summary;

        if (contentChanged || enhancedContentChanged || titleChanged || summaryChanged) {
          stats.chunksModified++;

          // Merge replacement counts from content
          contentResult.replacements.forEach((count, rule) => {
            const currentCount = stats.replacementsByRule.get(rule) || 0;
            stats.replacementsByRule.set(rule, currentCount + count);
            stats.totalReplacements += count;
          });

          // Merge replacement counts from enhancedContent
          if (enhancedContentResult) {
            enhancedContentResult.replacements.forEach((count, rule) => {
              const currentCount = stats.replacementsByRule.get(rule) || 0;
              stats.replacementsByRule.set(rule, currentCount + count);
              stats.totalReplacements += count;
            });
          }

          // Merge replacement counts from title
          if (titleResult) {
            titleResult.replacements.forEach((count, rule) => {
              const currentCount = stats.replacementsByRule.get(rule) || 0;
              stats.replacementsByRule.set(rule, currentCount + count);
              stats.totalReplacements += count;
            });
          }

          // Merge replacement counts from summary
          if (summaryResult) {
            summaryResult.replacements.forEach((count, rule) => {
              const currentCount = stats.replacementsByRule.get(rule) || 0;
              stats.replacementsByRule.set(rule, currentCount + count);
              stats.totalReplacements += count;
            });
          }

          if (!dryRun) {
            try {
              // Generate new embedding for corrected content
              const newEmbedding = await createEmbedding(contentResult.correctedText);

              updates.push({
                pointId: chunk.pointId,
                chunkId: chunk.chunkId,
                content: contentResult.correctedText,
                enhancedContent: enhancedContentResult?.correctedText,
                title: titleResult?.correctedText,
                summary: summaryResult?.correctedText,
                embedding: newEmbedding
              });

              // Add a small delay to avoid overwhelming the API
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
              const errorMsg = `Failed to process chunk ${chunk.chunkId}: ${error}`;
              console.error(errorMsg);
              stats.errors.push(errorMsg);
            }
          }
        }

        // Log progress every 100 chunks
        if (stats.totalChunksProcessed % 100 === 0) {
          console.log(`Processed ${stats.totalChunksProcessed}/${chunks.length} chunks...`);
        }
      }

      // Update chunks in database if not dry run
      if (!dryRun && updates.length > 0) {
        console.log(`Updating ${updates.length} chunks in database...`);
        await this.dbService.updateChunks(updates);
      }

      stats.processingTimeMs = Date.now() - startTime;

      console.log('Correction completed!');
      console.log(`Total chunks processed: ${stats.totalChunksProcessed}`);
      console.log(`Chunks modified: ${stats.chunksModified}`);
      console.log(`Total replacements: ${stats.totalReplacements}`);
      console.log(`Processing time: ${stats.processingTimeMs}ms`);

      return stats;
    } catch (error) {
      console.error('Error during transcript correction:', error);
      stats.errors.push(`Fatal error: ${error}`);
      stats.processingTimeMs = Date.now() - startTime;
      throw error;
    }
  }

  /**
   * Correct spelling mistakes in YouTube video transcripts only
   */
  async correctYoutubeTranscripts(
    videoId?: string,
    correctionRules: CorrectionRule[] = DEFAULT_BUDDHIST_CORRECTIONS,
    dryRun: boolean = false
  ): Promise<CorrectionStats> {
    // Create filter for YouTube transcripts
    const filter = videoId
      ? {
          must: [
            {
              key: 'id',
              match: {
                text: `youtube_${videoId}`,
                exact: false
              }
            }
          ]
        }
      : {
          must: [
            {
              key: 'id',
              match: {
                text: 'youtube_',
                exact: false
              }
            }
          ]
        };

    return this.correctAllTranscripts(correctionRules, filter, dryRun);
  }
}

