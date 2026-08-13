import { useEffect } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import AuthGate from '@/components/auth/AuthGate';
import AppShell from '@/components/layout/AppShell';
import { clearPendingInvite, readPendingInvite, pendingInvitePath } from '@/lib/pending-invite';
import Account from './screens/Account';
import Activity from './screens/Activity';
import FriendDetail from './screens/FriendDetail';
import Friends from './screens/Friends';
import GroupDetail from './screens/GroupDetail';
import Home from './screens/Home';
import FriendInvite from './screens/FriendInvite';
import Join from './screens/Join';
import NotFound from './screens/NotFound';

/**
 * After sign-in, deliver the user to the invite they arrived on. shoo's own
 * returnTo can be lost across the OAuth redirect (see pending-invite.ts), which
 * would strand them on Home; this catches that case. Renders inside AuthGate, so
 * it only runs once authenticated.
 */
function PendingInviteRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const pending = readPendingInvite();
    if (!pending) return;
    // One-shot: consume the marker immediately so it can never fire twice or
    // hijack a later sign-in. The user is on the invite URL from here on.
    clearPendingInvite();
    const target = pendingInvitePath(pending);
    if (location.pathname !== target) navigate(target, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function App() {
  return (
    <AuthGate>
      <PendingInviteRedirect />
      <AppShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/groups/:id" element={<GroupDetail />} />
          <Route path="/friends" element={<Friends />} />
          <Route path="/friends/:id" element={<FriendDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/account" element={<Account />} />
          <Route path="/join/:token" element={<Join />} />
          <Route path="/friend/:token" element={<FriendInvite />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppShell>
    </AuthGate>
  );
}
