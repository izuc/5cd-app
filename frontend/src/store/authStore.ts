import { create } from 'zustand';
import { api } from '../api/client';

interface User {
  id: number;
  email: string;
  display_name: string;
  credits: number;
  plan: string;
  theme_color: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
  fetchUser: () => Promise<void>;
  setCredits: (credits: number) => void;
}

const TOKEN_KEY = '5cd-single-token';

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: localStorage.getItem(TOKEN_KEY),
  loading: false,

  login: async (email, password) => {
    const res = await api.login({ email, password });
    localStorage.setItem(TOKEN_KEY, res.token);
    set({ token: res.token, user: res.user });
  },

  register: async (email, password, displayName) => {
    const res = await api.register({ email, password, display_name: displayName });
    localStorage.setItem(TOKEN_KEY, res.token);
    set({ token: res.token, user: res.user });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ token: null, user: null });
  },

  fetchUser: async () => {
    try {
      set({ loading: true });
      const res = await api.me();
      set({ user: res.user, loading: false });
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      set({ token: null, user: null, loading: false });
    }
  },

  setCredits: (credits) => {
    set((state) => state.user ? { user: { ...state.user, credits } } : state);
  },
}));
