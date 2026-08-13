import { createContext, useContext } from 'react';

export interface AuthActions {
  /** Starts the shoo.dev Google sign-in redirect. */
  signIn: () => Promise<void>;
  /** Clears the locally stored shoo identity (used on sign-out). */
  clearIdentity: () => void;
}

export const AuthActionsContext = createContext<AuthActions | null>(null);

export function useAuthActions(): AuthActions {
  const ctx = useContext(AuthActionsContext);
  if (!ctx) throw new Error('useAuthActions must be used inside <AuthGate>');
  return ctx;
}
