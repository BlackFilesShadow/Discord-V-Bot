import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Servers from './pages/Servers';
import Server from './pages/Server';
import ServerSlot from './pages/ServerSlot';
import Dev from './pages/Dev';

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid place-items-center h-full text-muted">Lade…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/servers" element={<Protected><Servers /></Protected>} />
      <Route path="/servers/:guildId" element={<Protected><Server /></Protected>} />
      <Route path="/servers/:guildId/server/:slot" element={<Protected><ServerSlot /></Protected>} />
      <Route path="/dev" element={<Protected><Dev /></Protected>} />
      <Route path="*" element={<Navigate to="/servers" replace />} />
    </Routes>
  );
}
