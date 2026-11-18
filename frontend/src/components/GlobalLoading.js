import React from 'react';
import { createPortal } from 'react-dom';

const GlobalLoading = ({ isLoading, message = 'Loading...' }) => {
  if (!isLoading) return null;
  
  return createPortal(
    <div className="global-loading-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-spinner-container">
        <div className="loading-spinner"></div>
        <p className="loading-message">{message}</p>
      </div>
    </div>,
    document.body
  );
};

// Skeleton Loader Components
export const SkeletonCard = ({ lines = 3 }) => (
  <div className="skeleton-card">
    {[88, 72, 64, 90, 55].slice(0, lines).map((width, i) => (
      <div key={i} className="skeleton-line" style={{ 
        width: `${width}%`,
        animationDelay: `${i * 0.1}s`
      }} />
    ))}
  </div>
);

export const SkeletonGrid = ({ items = 4, lines = 2 }) => (
  <div className="skeleton-grid">
    {Array.from({ length: items }).map((_, i) => (
      <SkeletonCard key={i} lines={lines} />
    ))}
  </div>
);

export default GlobalLoading;
