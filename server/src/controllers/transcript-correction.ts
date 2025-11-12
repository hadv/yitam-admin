import { Request, Response } from 'express';
import { 
  TranscriptCorrectionService, 
  CorrectionRule, 
  DEFAULT_BUDDHIST_CORRECTIONS 
} from '../services/transcript-correction';

// Create a singleton instance of the correction service
const correctionService = new TranscriptCorrectionService();

/**
 * Correct spelling mistakes in all transcripts
 * POST /api/youtube/correct-transcripts
 * Body: {
 *   correctionRules?: CorrectionRule[],
 *   dryRun?: boolean
 * }
 */
export const correctAllTranscripts = async (req: Request, res: Response) => {
  try {
    const { correctionRules, dryRun = false } = req.body;

    // Use provided rules or default Buddhist corrections
    const rules: CorrectionRule[] = correctionRules || DEFAULT_BUDDHIST_CORRECTIONS;

    console.log(`Starting transcript correction (dry run: ${dryRun})`);
    console.log(`Using ${rules.length} correction rules`);

    // Run correction
    const stats = await correctionService.correctAllTranscripts(rules, undefined, dryRun);

    // Format response
    const replacementDetails = Array.from(stats.replacementsByRule.entries()).map(
      ([rule, count]) => ({ rule, count })
    );

    res.status(200).json({
      success: stats.errors.length === 0,
      message: dryRun 
        ? 'Dry run completed - no changes were made' 
        : 'Transcript correction completed',
      dryRun,
      stats: {
        totalChunksProcessed: stats.totalChunksProcessed,
        chunksModified: stats.chunksModified,
        totalReplacements: stats.totalReplacements,
        processingTimeMs: stats.processingTimeMs,
        replacementDetails
      },
      errors: stats.errors.length > 0 ? stats.errors : undefined
    });
  } catch (error) {
    console.error('Error correcting transcripts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to correct transcripts',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Correct spelling mistakes in YouTube transcripts only
 * POST /api/youtube/correct-youtube-transcripts
 * Body: {
 *   videoId?: string,
 *   correctionRules?: CorrectionRule[],
 *   dryRun?: boolean
 * }
 */
export const correctYoutubeTranscripts = async (req: Request, res: Response) => {
  try {
    const { videoId, correctionRules, dryRun = false } = req.body;

    // Use provided rules or default Buddhist corrections
    const rules: CorrectionRule[] = correctionRules || DEFAULT_BUDDHIST_CORRECTIONS;

    console.log(`Starting YouTube transcript correction (dry run: ${dryRun})`);
    if (videoId) {
      console.log(`Targeting video ID: ${videoId}`);
    } else {
      console.log('Targeting all YouTube transcripts');
    }
    console.log(`Using ${rules.length} correction rules`);

    // Run correction
    const stats = await correctionService.correctYoutubeTranscripts(videoId, rules, dryRun);

    // Format response
    const replacementDetails = Array.from(stats.replacementsByRule.entries()).map(
      ([rule, count]) => ({ rule, count })
    );

    res.status(200).json({
      success: stats.errors.length === 0,
      message: dryRun 
        ? 'Dry run completed - no changes were made' 
        : 'YouTube transcript correction completed',
      dryRun,
      videoId: videoId || 'all',
      stats: {
        totalChunksProcessed: stats.totalChunksProcessed,
        chunksModified: stats.chunksModified,
        totalReplacements: stats.totalReplacements,
        processingTimeMs: stats.processingTimeMs,
        replacementDetails
      },
      errors: stats.errors.length > 0 ? stats.errors : undefined
    });
  } catch (error) {
    console.error('Error correcting YouTube transcripts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to correct YouTube transcripts',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get default Buddhist correction rules
 * GET /api/youtube/correction-rules
 */
export const getCorrectionRules = async (req: Request, res: Response) => {
  try {
    res.status(200).json({
      success: true,
      rules: DEFAULT_BUDDHIST_CORRECTIONS,
      description: 'Default correction rules for Buddhist terminology in Vietnamese'
    });
  } catch (error) {
    console.error('Error getting correction rules:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get correction rules',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Preview corrections without applying them
 * POST /api/youtube/preview-corrections
 * Body: {
 *   text: string,
 *   correctionRules?: CorrectionRule[]
 * }
 */
export const previewCorrections = async (req: Request, res: Response) => {
  try {
    const { text, correctionRules } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Text is required'
      });
    }

    // Use provided rules or default Buddhist corrections
    const rules: CorrectionRule[] = correctionRules || DEFAULT_BUDDHIST_CORRECTIONS;

    // Apply corrections
    let correctedText = text;
    const replacements: Array<{ rule: string; count: number }> = [];

    for (const rule of rules) {
      const flags = rule.caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(rule.incorrect, flags);
      
      const matches = correctedText.match(regex);
      const count = matches ? matches.length : 0;
      
      if (count > 0) {
        correctedText = correctedText.replace(regex, rule.correct);
        replacements.push({
          rule: `${rule.incorrect} → ${rule.correct}`,
          count
        });
      }
    }

    res.status(200).json({
      success: true,
      originalText: text,
      correctedText,
      hasChanges: text !== correctedText,
      replacements
    });
  } catch (error) {
    console.error('Error previewing corrections:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to preview corrections',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

