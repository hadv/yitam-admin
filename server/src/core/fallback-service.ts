// Generic fallback service to handle service unavailability consistently
export class FallbackService {
  private warningFlags: Map<string, boolean> = new Map();
  private lastAttemptTime: Map<string, number> = new Map();
  private isUsingFallback: boolean = false;
  
  // Configuration for retry behavior
  private retryIntervalMs: number = 60000; // Try primary service again after 1 minute
  
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
    forceFallback = false
  ): Promise<T> {
    // If explicitly in fallback mode and retry interval hasn't elapsed, use fallback immediately
    if (forceFallback && !this.shouldRetryPrimary(operation)) {
      return Promise.resolve(fallbackFn());
    }
    
    // Try primary function, with fallback on error
    return primaryFn().then(result => {
      // If we get here, primary function succeeded - reset fallback state
      this.isUsingFallback = false;
      this.resetWarningFlag(operation);
      return result;
    }).catch((error) => {
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
    this.isUsingFallback = true;
    this.lastAttemptTime.set(errorKey, Date.now());
    
    // Only log the full warning once per service+operation combination
    if (!this.warningFlags.get(errorKey)) {
      console.warn(`${this.serviceName} unavailable during ${operation}. Using fallback until service is available.`);
      
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
  public resetWarningFlag(operation?: string): void {
    if (operation) {
      const errorKey = `${this.serviceName}:${operation}`;
      this.warningFlags.delete(errorKey);
      this.lastAttemptTime.delete(errorKey);
    } else {
      // Reset all warning flags for this service
      for (const key of this.warningFlags.keys()) {
        if (key.startsWith(`${this.serviceName}:`)) {
          this.warningFlags.delete(key);
          this.lastAttemptTime.delete(key);
        }
      }
    }
  }
  
  /**
   * Determines if we should attempt the primary service again after a failure
   * @param operation The operation being performed
   * @returns True if enough time has passed to retry the primary service
   */
  private shouldRetryPrimary(operation: string): boolean {
    const errorKey = `${this.serviceName}:${operation}`;
    const lastAttempt = this.lastAttemptTime.get(errorKey);
    
    // If no failed attempt recorded or enough time has passed since last attempt
    if (!lastAttempt || Date.now() - lastAttempt > this.retryIntervalMs) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Check if the service is currently in fallback mode
   */
  public isFallbackActive(): boolean {
    return this.isUsingFallback;
  }
  
  /**
   * Force the service to try the primary implementation next time
   */
  public forceRetryPrimary(): void {
    this.isUsingFallback = false;
    this.resetWarningFlag();
  }
  
  /**
   * Set retry interval for attempting primary service after failure
   * @param intervalMs Interval in milliseconds
   */
  public setRetryInterval(intervalMs: number): void {
    if (intervalMs > 0) {
      this.retryIntervalMs = intervalMs;
    }
  }
} 