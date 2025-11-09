import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import axios from 'axios';
import { API_BASE_URL } from '../config';

interface User {
  id: string;
  name: string;
  username: string;
  role: 'user' | 'admin';
  golfPassword?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  checkAuth: () => Promise<void>;
  setUser: (user: User) => void;
}

const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: (token, user) => {
        set({ user, token, isAuthenticated: true });
        axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      },

      logout: () => {
        set({ user: null, token: null, isAuthenticated: false });
        delete axios.defaults.headers.common['Authorization'];
      },

      checkAuth: async () => {
        const { token, user: currentUser, isAuthenticated } = get();

        if (!token) {
          get().logout();
          return;
        }

        try {
          axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
          const response = await axios.get(`${API_BASE_URL}/api/auth/check`);
          const fetchedUser = response.data.user as User;

          const hasChanged =
            !currentUser ||
            currentUser.id !== fetchedUser.id ||
            currentUser.username !== fetchedUser.username ||
            currentUser.name !== fetchedUser.name ||
            currentUser.role !== fetchedUser.role ||
            (currentUser.golfPassword ?? '') !== (fetchedUser.golfPassword ?? '');

          if (!isAuthenticated || hasChanged) {
            set({ user: fetchedUser, isAuthenticated: true });
          }
        } catch (error) {
          get().logout();
        }
      },

      setUser: (user) => {
        set((state) => ({ user, token: state.token, isAuthenticated: true }));
      },
    }),
    {
      name: 'auth-storage', // unique name
    }
  )
);

// Initialize axios header on load
const initialToken = useAuthStore.getState().token;
if (initialToken) {
  axios.defaults.headers.common['Authorization'] = `Bearer ${initialToken}`;
}

export default useAuthStore;
