export interface YoutubeVideoChunk {
  id: string;
  documentName: string;
  content: string;
  enhancedContent?: string;
  title: string;
  summary: string;
  sourceFile: string;
  domains: string[];
  score: number;
}

export interface YoutubeVideoInfo {
  videoId: string;
  chunks: YoutubeVideoChunk[];
  totalChunks: number;
  domains: string[];
  message: string;
}

export interface YoutubeVideoDetails {
  videoId: string;
  title?: string;
  description?: string;
  url: string;
}
