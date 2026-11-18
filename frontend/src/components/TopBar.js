import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { getCurrentUser, userPhotoSrc } from '../services/api';
import { useUI, useSidebar } from '../App';

const TopBar = () => {
const { collapsed, mobileOpen, toggleSidebar } = useSidebar();

  const { user, isAuthenticated } = useAuth();
  const { theme, motionMode, toggleTheme, cycleMotionMode } = useUI();
  const [comingSoon, setComingSoon] = useState(null);
  const timerRef = useRef(null);
  const userEmail = user?.email?.trim().toLowerCase() || '';
  const profilePhotos = {
    'kshitijpathak1@kpmg.com': { src: '/kp.jpg', alt: 'Kshitij profile' },
    'harnathbabu@kpmg.com': { src: '/HB.jpg', alt: 'Harnath profile' },
    'saurabhoberoi@kpmg.com': { src: '/Saurabh.png', alt: 'Saurabh profile' },
  };
  // A picture uploaded from the admin panel wins over the built-in ones above.
  const [uploadedPhoto, setUploadedPhoto] = useState('');
  useEffect(() => {
    let cancelled = false;
    setUploadedPhoto('');
    if (!isAuthenticated || !userEmail) return undefined;
    getCurrentUser()
      .then((me) => { if (!cancelled) setUploadedPhoto(userPhotoSrc(me?.photo_url)); })
      .catch(() => {}); // keep the fallback picture
    return () => { cancelled = true; };
  }, [isAuthenticated, userEmail]);
  const userProfilePhoto = uploadedPhoto
    ? { src: uploadedPhoto, alt: `${user?.full_name || userEmail} profile` }
    : profilePhotos[userEmail];

  const showComingSoon = () => {
    setComingSoon(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setComingSoon(false), 2000);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="sidebar-collapse-btn resBtn"
          onClick={toggleSidebar}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label="Toggle sidebar"
        >
          <span style={{display :'flex', justifyContent: 'center', alignItems: 'center'}}>{collapsed
            ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          }</span>
        </button>
        <span className="topbar-date">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
      </div>
      <div className="topbar-right">
        <div className="topbar-actions">
          <button className="topbar-btn" title="Toggle theme" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark'
              ? 
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            }
          </button>
          <button className="topbar-btn dsNon" title="Motion mode" onClick={cycleMotionMode} aria-label="Cycle motion mode">
            Motion: {motionMode}
          </button>
          <button className="topbar-btn" title="Notifications" aria-label="Notifications" onClick={showComingSoon}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></button>
          <button className="topbar-btn" title="Settings" aria-label="Settings" onClick={showComingSoon}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          {isAuthenticated && user && (
            <div className="profile-section">
              <span>{user.full_name || user.email}</span>
              {userProfilePhoto ? (
                <img
                  src={userProfilePhoto.src}
                  alt={userProfilePhoto.alt}
                  onError={uploadedPhoto ? () => setUploadedPhoto('') : undefined}
                  className="profile-avatar profile-avatar-image"
                />
              ) : (
                <div className="profile-avatar" aria-hidden="true"></div>
              )}
            </div>
          )}
        </div>
      </div>
      {comingSoon && (
        <div className="coming-soon-popup">
          Coming Soon
        </div>
      )}
    </header>
  );
};

export default TopBar;
