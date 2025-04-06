// Generic fallback service to handle service unavailability consistently
export class FallbackService {
  private warningFlags: Map<string, boolean> = new Map();
  
  constructor(private serviceName: string) {}
  
  /**
   * Execute an operation with automatic fallback if the primary method fails
   * @param operation Operation name for logging
   * @param fallbackFn Function to execute as fallback
   * @param primaryFn Function to try first
   * @returns Result of either primary or fallback function
   */
  public async withFallback<T>(
    operation: string,
    fallbackFn: () => T,
    primaryFn: () => Promise<T>,
    isUsingFallbackMode = false
  ): Promise<T> {
    // If already in fallback mode, use fallback immediately
    if (isUsingFallbackMode) {
      return Promise.resolve(fallbackFn());
    }
    
    // Otherwise try primary function first, with fallback on error
    return primaryFn().catch((error) => {
      this.handleError(operation, error);
      return fallbackFn();
    });
  }
  
  /**
   * Handle errors consistently with proper logging
   * @param operation Name of the operation that failed
   * @param error Error that occurred
   */
  public handleError(operation: string, error: any): void {
    const errorKey = `${this.serviceName}:${operation}`;
    
    // Only log the full warning once per service+operation combination
    if (!this.warningFlags.get(errorKey)) {
      console.warn(`${this.serviceName} unavailable during ${operation}. Using fallback.`);
      
      // Add service-specific guidance
      if (this.serviceName === 'Qdrant') {
        console.warn(`Ensure ${this.serviceName} is running at the configured URL with proper credentials.`);
        console.warn('You can install Qdrant using Docker: docker run -p 6333:6333 qdrant/qdrant');
      } else if (this.serviceName === 'Embedding') {
        console.warn('Check your embedding service configuration and connectivity.');
      }
      
      this.warningFlags.set(errorKey, true);
    } else {
      // For subsequent errors, just log a debug message
      console.debug(`${this.serviceName} still unavailable during ${operation}. Using fallback.`);
    }
    
    // If it's not a connection refused error, log more details for debugging
    if (error?.cause?.code !== 'ECONNREFUSED') {
      console.error(`Unexpected error in ${this.serviceName} during ${operation}:`, error);
    }
  }
  
  /**
   * Reset the warning flag for an operation
   * @param operation Operation name to reset
   */
  public resetWarningFlag(operation: string): void {
    const errorKey = `${this.serviceName}:${operation}`;
    this.warningFlags.delete(errorKey);
  }
} 