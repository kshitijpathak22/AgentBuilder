import React, { createContext, useContext, useState, useCallback } from 'react';
import { login as apiLogin, logout as apiLogout, getCurrentUser } from '../services/api';
import useSessionStore from '../store/sessionStore';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const token = localStorage.getItem('access_token');
    const storedEmail = localStorage.getItem('email');
    const storedRole = localStorage.getItem('role') || 'user';
    return token && storedEmail
      ? {
          email: storedEmail,
          full_name: localStorage.getItem('full_name') || '',
          role: storedRole,
          is_admin: storedRole === 'admin' || storedRole === 'developer',
        }
      : null;
  });

  const login = useCallback(async (email) => {
    // Clear any stale tokens and session data from a previous session before logging in
    apiLogout();
    useSessionStore.getState().clearSession();
    const data = await apiLogin(email);
    const userRole = data.role || (data.is_admin ? 'admin' : 'user');
    localStorage.setItem('email', email);
    localStorage.setItem('full_name', data.full_name || '');
    localStorage.setItem('role', userRole);
    setUser({
      email,
      full_name: data.full_name || '',
      role: userRole,
      is_admin: userRole === 'admin' || userRole === 'developer' || !!data.is_admin,
    });
    return data;
  }, []);

  const refreshUserInfo = useCallback(async () => {
    try {
      const userInfo = await getCurrentUser();
      const userRole = userInfo.role || (userInfo.is_admin ? 'admin' : 'user');
      localStorage.setItem('email', userInfo.email);
      localStorage.setItem('full_name', userInfo.full_name || '');
      localStorage.setItem('role', userRole);
      setUser({
        email: userInfo.email,
        full_name: userInfo.full_name || '',
        role: userRole,
        is_admin: userRole === 'admin' || userRole === 'developer' || !!userInfo.is_admin,
      });
    } catch {
      // Token invalid — clear everything
      apiLogout();
      localStorage.removeItem('email');
      localStorage.removeItem('full_name');
      localStorage.removeItem('role');
      setUser(null);
    }
  }, []);

  const logout = useCallback(() => {
    apiLogout();
    useSessionStore.getState().clearSession();
    localStorage.removeItem('email');
    localStorage.removeItem('full_name');
    localStorage.removeItem('role');
    setUser(null);
  }, []);

  const isAuthenticated = !!user;
  const isDeveloper = user?.role === 'developer';
  const isAdmin = user?.role === 'admin' || user?.role === 'developer' || !!user?.is_admin;

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        logout,
        refreshUserInfo,
        isAuthenticated,
        isAdmin,
        isDeveloper,
        role: user?.role || 'user',
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
