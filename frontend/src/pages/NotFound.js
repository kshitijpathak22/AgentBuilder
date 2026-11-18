import React from 'react';
import { Link } from 'react-router-dom';

const NotFound = () => {
  return (
    <div className="page not-found">
      <h2>Page Not Found</h2>
      <p>The page you're looking for doesn't exist.</p>
      <Link to="/dashboard" className="btn">Go to Dashboard</Link>
    </div>
  );
};

export default NotFound;
