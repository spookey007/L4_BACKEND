/**
 * Server-side debug utility for conditional logging based on environment
 * Works in Node.js server environment
 */

const isDevelopment = () => {
  return process.env.NODE_ENV === 'development';
};

const debug = {
  log: (...args) => {
    if (isDevelopment()) {
      console.log(...args);
    }
  },
  
  warn: (...args) => {
    if (isDevelopment()) {
      console.warn(...args);
    }
  },
  
  error: (...args) => {
    if (isDevelopment()) {
      console.error(...args);
    }
  },
  
  info: (...args) => {
    if (isDevelopment()) {
      console.info(...args);
    }
  },
  
  group: (label) => {
    if (isDevelopment()) {
      console.group(label);
    }
  },
  
  groupEnd: () => {
    if (isDevelopment()) {
      console.groupEnd();
    }
  },
  
  time: (label) => {
    if (isDevelopment()) {
      console.time(label);
    }
  },
  
  timeEnd: (label) => {
    if (isDevelopment()) {
      console.timeEnd(label);
    }
  },
  
  // Additional utility methods
  isEnabled: () => isDevelopment(),
  
  // Force logging (useful for critical errors)
  forceLog: (...args) => {
    console.log(...args);
  },
  
  forceWarn: (...args) => {
    console.warn(...args);
  },
  
  forceError: (...args) => {
    console.error(...args);
  }
};

module.exports = debug;
