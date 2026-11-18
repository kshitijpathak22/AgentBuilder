import React, { useEffect, useState, createContext, useContext } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Header from './components/Header';
import TopBar from './components/TopBar';
import ErrorBoundary from './components/ErrorBoundary';
import GlobalLoading from './components/GlobalLoading';
import Dashboard from './pages/Dashboard';
import SetupSession from './pages/SetupSession';
import ActiveSession from './pages/ActiveSession';
import Evaluation from './pages/Evaluation';
import PracticeHistory from './pages/PracticeHistory';
import ProgressTracking from './pages/ProgressTracking';
import NotFound from './pages/NotFound';
import Login from './pages/Login';
import Admin from './pages/Admin';
import Telemetry from './pages/Telemetry';
import Developer from './pages/Developer';
import { AuthProvider, useAuth } from './context/AuthContext';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

// Global Loading Context
export const LoadingContext = createContext();

export const useGlobalLoading = () => {
  const context = useContext(LoadingContext);
  if (!context) {
    throw new Error('useGlobalLoading must be used within LoadingProvider');
  }
  return context;
};

// Sidebar Collapse Context
export const SidebarContext = createContext();

export const UIContext = createContext();

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within SidebarProvider');
  }
  return context;
};

export const useUI = () => {
  const context = useContext(UIContext);
  if (!context) {
    throw new Error('useUI must be used within UIProvider');
  }
  return context;
};

// Protected route wrapper - redirects to login if not authenticated
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

// Admin-only route wrapper - redirects non-admin/developer users to dashboard
const AdminRoute = ({ children }) => {
  const { isAuthenticated, isAdmin, isDeveloper, user } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (!isAdmin && !isDeveloper && !user?.is_admin && user?.role !== 'developer') {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
};

// Developer-only route wrapper - redirects non-developer users to dashboard
const DeveloperRoute = ({ children }) => {
  const { isAuthenticated, isDeveloper, user } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (!isDeveloper && user?.role !== 'developer') {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
};

// Layout wrapper for authenticated pages (with collapsible sidebar + persistent topbar)
const AuthenticatedLayout = ({ children }) => {
  const { mobileOpen, setMobileOpen } = useSidebar();

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {/* Mobile overlay */}
      <div
        className={`sidebar-overlay ${mobileOpen ? 'active' : ''}`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      <Header />
      <div className="app-layout">
        <TopBar />
        <main id="main-content" className="main-content" role="main" tabIndex={-1}>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};

// Full-screen layout for public/auth pages (no sidebar/topbar)
const PublicLayout = ({ children }) => (
  <div className="app-public">
    <ErrorBoundary>
      {children}
    </ErrorBoundary>
  </div>
);

const AppContent = () => {
  const [globalLoading, setGlobalLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Loading...');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [motionMode, setMotionMode] = useState('default');

  useEffect(() => {
    const savedTheme = localStorage.getItem('sc-theme');
    const resolvedTheme = savedTheme || 'dark';
    setTheme(resolvedTheme);
    document.documentElement.setAttribute('data-theme', resolvedTheme);

    const savedMotion = localStorage.getItem('sc-motion');
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resolvedMotion = savedMotion || (prefersReduced ? 'reduced' : 'default');
    setMotionMode(resolvedMotion);
    document.documentElement.setAttribute('data-motion', resolvedMotion);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('sc-theme', nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
  };

  const cycleMotionMode = () => {
    const order = ['default', 'reduced', 'none'];
    const currentIndex = order.indexOf(motionMode);
    const nextMotion = order[(currentIndex + 1) % order.length];
    setMotionMode(nextMotion);
    localStorage.setItem('sc-motion', nextMotion);
    document.documentElement.setAttribute('data-motion', nextMotion);
  };

  const showLoading = (message = 'Loading...') => {
    setLoadingMessage(message);
    setGlobalLoading(true);
  };

  const hideLoading = () => {
    setGlobalLoading(false);
  };

  const toggleSidebar = () => {
    // On mobile, toggle the overlay
    if (window.innerWidth <= 768) {
      setMobileOpen(prev => !prev);
    } else {
      setSidebarCollapsed(prev => !prev);
    }
  };

  return (
    <LoadingContext.Provider value={{ showLoading, hideLoading }}>
      <UIContext.Provider value={{ theme, motionMode, toggleTheme, cycleMotionMode }}>
        <SidebarContext.Provider value={{
          collapsed: sidebarCollapsed,
          setCollapsed: setSidebarCollapsed,
          mobileOpen,
          setMobileOpen,
          toggleSidebar
        }}>
          <Router>
            <GlobalLoading isLoading={globalLoading} message={loadingMessage} />
            <Routes>
            {/* Public routes - full screen, no sidebar/topbar */}
            <Route path="/login" element={
              <PublicLayout>
                <Login />
              </PublicLayout>
            } />

            {/* Protected routes - with collapsible sidebar + persistent topbar layout */}
            <Route path="/dashboard" element={
              <ProtectedRoute>
                <AuthenticatedLayout>
                  <Dashboard />
                </AuthenticatedLayout>
              </ProtectedRoute>
            } />
            <Route path="/setup" element={
              <ProtectedRoute>
                <AuthenticatedLayout>
                  <SetupSession />
                </AuthenticatedLayout>
              </ProtectedRoute>
            } />
            <Route path="/session" element={
              <ProtectedRoute>
                <AuthenticatedLayout>
                  <ActiveSession />
                </AuthenticatedLayout>
              </ProtectedRoute>
            } />
            <Route path="/evaluation" element={
              <ProtectedRoute>
                <AuthenticatedLayout>
                  <Evaluation />
                </AuthenticatedLayout>
              </ProtectedRoute>
            } />
            <Route path="/history" element={
              <ProtectedRoute>
                <AuthenticatedLayout>
                  <PracticeHistory />
                </AuthenticatedLayout>
              </ProtectedRoute>
            } />
            <Route path="/progress" element={
              <ProtectedRoute>
                <AuthenticatedLayout>
                  <ProgressTracking />
                </AuthenticatedLayout>
              </ProtectedRoute>
            } />

<Route
  path="/telemetry"
  element={
    <ProtectedRoute>
      <AuthenticatedLayout>
        <Telemetry />
      </AuthenticatedLayout>
    </ProtectedRoute>
  }
/>

            <Route path="/admin" element={
              <AdminRoute>
                <AuthenticatedLayout>
                  <Admin />
                </AuthenticatedLayout>
              </AdminRoute>
            } />
            <Route path="/developer" element={
              <DeveloperRoute>
                <AuthenticatedLayout>
                  <Developer />
                </AuthenticatedLayout>
              </DeveloperRoute>
            } />

            {/* Default redirect */}
            <Route path="/" element={
              <ProtectedRoute>
                <Navigate to="/dashboard" replace />
              </ProtectedRoute>
            } />

            <Route path="*" element={
              <PublicLayout>
                <NotFound />
              </PublicLayout>
            } />
            </Routes>
          </Router>
        </SidebarContext.Provider>
      </UIContext.Provider>
    </LoadingContext.Provider>
  );
};

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </QueryClientProvider>
  );
};

export default App;
