// error-handler.js v1.0 — Automatic Error Capture & Logging
'use strict';

const ErrorHandler = {
  // Configuration
  maxCachedErrors: 50,
  autoSendToServer: true,
  serverUrl: 'http://127.0.0.1:4000/system-log',  // TRADING AUTO EXCLUSIVE
  
  // State
  errorCache: [],
  offlineQueue: [],
  
  // ── Initialize Error Capture ───────────────────────────────────────────
  init() {
    // Capture uncaught exceptions
    window.addEventListener('error', (event) => {
      this.captureError({
        type: 'uncaught_exception',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack || 'No stack trace',
        module: this.detectModule(event.filename)
      });
    });
    
    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.captureError({
        type: 'unhandled_rejection',
        message: event.reason?.message || String(event.reason),
        stack: event.reason?.stack || 'No stack trace',
        module: 'async_operation'
      });
    });
    
    // Periodically flush offline queue
    setInterval(() => this.flushOfflineQueue(), 10000);
  },
  
  // ── Capture Error ──────────────────────────────────────────────────────
  captureError(errorObj) {
    const errorRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...errorObj,
      context: {
        userAgent: navigator.userAgent,
        url: window.location.href,
        activeTab: this.getActiveTab()
      }
    };
    
    // Store locally
    this.errorCache.push(errorRecord);
    if (this.errorCache.length > this.maxCachedErrors) {
      this.errorCache.shift();
    }
    
    // Log to console for visibility
    console.error('[ERROR_HANDLER]', errorRecord.message, errorObj);
    
    // Send to server if enabled
    if (this.autoSendToServer) {
      this.sendToServer(errorRecord);
    }
    
    // Store in chrome storage for persistence
    try {
      chrome.storage.local.set({lastError: errorRecord});
    } catch (_) {}
    
    return errorRecord.id;
  },
  
  // ── Send to Server ────────────────────────────────────────────────────
  async sendToServer(errorRecord) {
    try {
      const response = await fetch(this.serverUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          from: 'popup-extension',
          to: 'server',
          action: 'ERROR_CAPTURED',
          status: 'ERROR',
          detail: {
            error: errorRecord.message,
            type: errorRecord.type,
            module: errorRecord.module,
            stack: errorRecord.stack,
            filename: errorRecord.filename,
            lineno: errorRecord.lineno,
            errorId: errorRecord.id
          },
          timestamp: errorRecord.timestamp
        })
      });
      
      if (!response.ok) {
        throw new Error(`Server ${response.status}: ${response.statusText}`);
      }
      
      console.log('[ERROR_HANDLER] Error sent to server:', errorRecord.id);
    } catch (err) {
      console.error('[ERROR_HANDLER] Failed to send to server:', err.message);
      // Add to offline queue
      this.offlineQueue.push(errorRecord);
    }
  },
  
  // ── Flush Offline Queue ────────────────────────────────────────────────
  async flushOfflineQueue() {
    if (this.offlineQueue.length === 0) return;
    
    const toSend = [...this.offlineQueue];
    this.offlineQueue = [];
    
    for (const errorRecord of toSend) {
      await this.sendToServer(errorRecord);
    }
  },
  
  // ── Get All Cached Errors ─────────────────────────────────────────────
  getErrors(limit = 20) {
    return this.errorCache.slice(-limit).reverse();
  },
  
  // ── Clear Errors ──────────────────────────────────────────────────────
  clearErrors() {
    this.errorCache = [];
    this.offlineQueue = [];
  },
  
  // ── Detect Module from Filename ────────────────────────────────────────
  detectModule(filename = '') {
    if (!filename) return 'unknown';
    if (filename.includes('popup.js')) return 'popup';
    if (filename.includes('chart')) return 'chart';
    if (filename.includes('ai-debugger')) return 'debugger';
    if (filename.includes('error-handler')) return 'error_handler';
    if (filename.includes('symbol-manager')) return 'symbol_mgr';
    if (filename.includes('mount')) return 'background';
    return 'extension';
  },
  
  // ── Get Active Tab ────────────────────────────────────────────────────
  getActiveTab() {
    const activeTab = document.querySelector('.tab.active');
    return activeTab ? activeTab.getAttribute('data-tab') : 'unknown';
  },
  
  // ── Format Error for Display ──────────────────────────────────────────
  formatError(errorRecord) {
    return `[${errorRecord.type}] ${errorRecord.message} (${errorRecord.module}) at ${errorRecord.timestamp}`;
  }
};

// Auto-init on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ErrorHandler.init());
} else {
  ErrorHandler.init();
}

// Export for use in other scripts
window.ErrorHandler = ErrorHandler;
