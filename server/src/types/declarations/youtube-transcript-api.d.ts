declare module 'youtube-transcript-api' {
  interface TranscriptItem {
    text: string;
    offset: number;
    duration: number;
  }

  interface TranscriptOptions {
    lang?: string;
  }

  export function getTranscript(videoId: string, options?: TranscriptOptions): Promise<TranscriptItem[]>;
} 